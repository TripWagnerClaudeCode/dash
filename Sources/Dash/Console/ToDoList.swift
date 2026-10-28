import Foundation

struct ToDoItem: Identifiable, Equatable {
    var id = UUID()
    var text: String
}

/// The user's own to-do list on the Today page: a notepad that only changes when they add, check off, or
/// delete something. Saved as a markdown checklist in Application Support, so chats can read and
/// edit it too.
@MainActor
final class ToDoList: ObservableObject {
    @Published private(set) var items: [ToDoItem] = []
    /// Items just checked off. They stay on screen, struck through, for a moment so a misclick can be undone.
    @Published private(set) var checked: Set<UUID> = []

    private static let header = "# To-do\n\n"
    private static let checkDelay: UInt64 = 1_500_000_000

    /// Why an edit didn't go through (the hub is offline), shown under the list.
    @Published private(set) var notice: String?

    /// The file's text as of the last load or save, so reload() can skip a file nobody else changed.
    private var lastText: String?
    /// Once paired, the list lives on the Dash hub and this Mac edits it through the hub. The local
    /// todo.md becomes a copy of it, so chats on this Mac still read the current list, and lines a chat
    /// adds or removes there are passed on to the hub.
    private var hub: HubClient?
    private var watch: Timer?
    /// Whether the local file has been mirrored from the hub's list yet this run.
    private var mirroredFromHub = false

    init() { reload() }

    private var usesHub: Bool { hub?.isPaired == true }

    func useHub(_ hub: HubClient) {
        self.hub = hub
        hub.on("todo") { [weak self] data in self?.applyHub(data["items"] as? [String] ?? []) }
        // Chats edit the local file; check it every few seconds (it's tiny).
        watch = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { if self?.usesHub == true { self?.reload() } }
        }
    }

    /// Picks up edits made outside the card (a chat adding an item, the user editing the file by hand).
    /// Items whose text didn't change keep their IDs, so a pending check-off survives.
    func reload() {
        let text = (try? String(contentsOf: Personal.todoURL, encoding: .utf8)) ?? ""
        guard text != lastText else { return }
        if usesHub {
            pushLocalEdits(Self.parse(text))
            return
        }
        lastText = text
        show(Self.parse(text))
    }

    private func show(_ lines: [String]) {
        var unused = items
        items = lines.map { line in
            if let index = unused.firstIndex(where: { $0.text == line }) {
                return unused.remove(at: index)
            }
            return ToDoItem(text: line)
        }
        checked.formIntersection(items.map(\.id))
    }

    /// The hub's list: show it and mirror it into the local file, unless the file has edits a chat made
    /// that haven't reached the hub yet. Those stay on disk until they're sent (the 3-second check does
    /// that once the hub is reachable), so they're never overwritten.
    private func applyHub(_ lines: [String]) {
        // The first list from the hub (often the saved copy, at launch) is what the file was last mirrored
        // from; anything else in the file was edited since.
        if !mirroredFromHub {
            mirroredFromHub = true
            lastText = Self.render(lines)
        }
        // No file yet (a first launch): nothing to keep, so start mirroring now.
        guard let text = try? String(contentsOf: Personal.todoURL, encoding: .utf8) else {
            show(lines)
            notice = nil
            write(lines)
            return
        }
        show(lines)
        notice = nil
        if text != lastText {
            if hub?.isOnline == true { pushLocalEdits(Self.parse(text)) }
            return
        }
        write(lines)
    }

    /// Sends what a chat changed in the local file (compared with the hub's list it was last mirrored
    /// from) to the hub, which echoes the new list back. Changes made elsewhere meanwhile are kept.
    private func pushLocalEdits(_ local: [String]) {
        guard let hub, hub.isOnline else { return }
        let base = Self.parse(lastText ?? "")
        let added = local.filter { !base.contains($0) }
        let removed = base.filter { !local.contains($0) }
        lastText = (try? String(contentsOf: Personal.todoURL, encoding: .utf8)) ?? ""
        for line in added where !items.contains(where: { $0.text == line }) { send("todo.add", line) }
        for line in removed where items.contains(where: { $0.text == line }) { send("todo.remove", line) }
    }

    private func send(_ type: String, _ text: String, failed: (() -> Void)? = nil) {
        guard let hub, hub.isOnline else {
            notice = "The Dash hub is offline, so the list is read-only for now."
            failed?()
            return
        }
        Task {
            do {
                let result = try await hub.request(type, ["text": text])
                applyHub(result["items"] as? [String] ?? items.map(\.text))
            } catch {
                notice = error.localizedDescription
                failed?()
            }
        }
    }

    /// `unsent` gets the text back if the hub couldn't take it, so the field can keep the draft.
    func add(_ text: String, unsent: ((String) -> Void)? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if usesHub { return send("todo.add", trimmed) { unsent?(text) } }
        change { $0.append(ToDoItem(text: trimmed)) }
    }

    /// Checking an item removes it after a short delay; checking it again first keeps it.
    func toggle(_ item: ToDoItem) {
        if checked.remove(item.id) != nil { return }
        checked.insert(item.id)
        Task {
            try? await Task.sleep(nanoseconds: Self.checkDelay)
            guard checked.remove(item.id) != nil else { return }
            delete(item)
        }
    }

    func delete(_ item: ToDoItem) {
        if usesHub { return send("todo.remove", item.text) }
        change { $0.removeAll { $0.id == item.id } }
    }

    /// The list as plain lines for the daily brief.
    var summary: String {
        items.isEmpty ? "(empty)" : items.map { "- \($0.text)" }.joined(separator: "\n")
    }

    /// Applies a change on top of the file as it is now, so an outside edit isn't overwritten.
    private func change(_ edit: (inout [ToDoItem]) -> Void) {
        reload()
        edit(&items)
        write(items.map(\.text))
    }

    private static func render(_ lines: [String]) -> String {
        header + lines.map { "- [ ] \($0)\n" }.joined()
    }

    private func write(_ lines: [String]) {
        let text = Self.render(lines)
        if text == lastText { return }
        do {
            try text.write(to: Personal.todoURL, atomically: true, encoding: .utf8)
            lastText = text
        } catch {
            Log.write("todo save failed: \(error.localizedDescription)")
        }
    }

    /// The text of every unchecked "- [ ] …" line. Lines checked by hand ("- [x]") count as done.
    private static func parse(_ text: String) -> [String] {
        text.components(separatedBy: "\n").compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("- [ ] ") else { return nil }
            let body = trimmed.dropFirst(6).trimmingCharacters(in: .whitespaces)
            return body.isEmpty ? nil : body
        }
    }
}
