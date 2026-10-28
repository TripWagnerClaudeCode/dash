import Combine
import Foundation

/// Mac Dash's side of Dash's memory, which lives on the hub (hub/src/memory.ts). The lens and lecture
/// recorder run on this Mac, so they report what happened here; entries wait on disk while the hub is
/// out of reach and go up when it's back. The lens also gets a short "what Dash knows about the user" from
/// the hub, kept on disk so it works offline. The Memory page reads and prunes the whole thing.
@MainActor
final class MemoryModel: ObservableObject {
    static let shared = MemoryModel()

    struct JournalEntry: Identifiable, Equatable {
        let day: String
        let text: String
        var id: String { day }
    }

    struct Snapshot: Equatable {
        var core = ""
        var selfNotes = ""
        var threads = ""
        var remember = ""
        var journal: [JournalEntry] = []
        var recent = ""
    }

    @Published private(set) var snapshot: Snapshot?
    @Published private(set) var loading = false
    @Published var error: String?

    /// The lens's persona and the user's core memory, ready to add to its system prompt. Nil until the hub sends it.
    private(set) var lensContext: String?
    private var contextFetched: Date?
    private weak var hub: HubClient?
    private var pending: [[String: Any]] = []
    private var flushing = false
    private var uploadingLocal = false
    private var watch: AnyCancellable?

    private static let pendingURL = HubClient.cacheDir.appendingPathComponent("pending-memory.json")
    private static let contextURL = HubClient.cacheDir.appendingPathComponent("lens-context.txt")
    /// Outside hub-cache, so unpairing doesn't make the local lines go up a second time.
    private static let uploadedURL = Personal.supportDir.appendingPathComponent("memory-uploaded.json")
    private static let maxPending = 500
    /// The most `memory.log` takes in one request is 500; smaller batches keep each request quick.
    private static let batchSize = 200

    /// Entries still waiting to go up, for `--hub-memory-check`.
    var queuedCount: Int { pending.count }

    func useHub(_ hub: HubClient) {
        self.hub = hub
        if let data = try? Data(contentsOf: Self.pendingURL),
           let saved = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            // Entries queued before they carried ids get one now, so the hub can tell a resend from a new entry.
            pending = saved.map { entry in
                guard !(entry["id"] is String) else { return entry }
                var entry = entry
                entry["id"] = UUID().uuidString
                return entry
            }
            if saved.contains(where: { !($0["id"] is String) }) { savePending() }
        }
        lensContext = try? String(contentsOf: Self.contextURL, encoding: .utf8)
        watch = hub.$state.sink { [weak self] state in
            switch state {
            case .online:
                // After the state change has landed, so requests see the hub online.
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        self?.flush()
                        self?.refreshLensContext()
                        self?.uploadLocalMemory()
                    }
                }
            case .unpaired:
                // Unpairing deleted hub-cache; what the hub knew about the user leaves the lens prompt too.
                self?.pending = []
                self?.lensContext = nil
                self?.contextFetched = nil
            default:
                break
            }
        }
    }

    /// Records something that happened on this Mac ("lens", "lecture"…) in Dash's memory.
    func log(source: String, kind: String, text: String, title: String? = nil) {
        guard hub?.isPaired == true, !text.isEmpty else { return }
        enqueue([Self.entry(source: source, kind: kind, text: text, title: title)])
    }

    private static func entry(source: String, kind: String, text: String, title: String? = nil) -> [String: Any] {
        var entry: [String: Any] = ["id": UUID().uuidString, "source": source, "kind": kind, "text": text,
                                    "at": ISO8601DateFormatter().string(from: Date())]
        if let title { entry["title"] = title }
        return entry
    }

    private func enqueue(_ entries: [[String: Any]]) {
        guard !entries.isEmpty else { return }
        pending.append(contentsOf: entries)
        if pending.count > Self.maxPending { pending.removeFirst(pending.count - Self.maxPending) }
        savePending()
        flush()
    }

    /// The lens asks for this before each new capture; it's fetched again every half hour.
    func refreshLensContextIfStale() {
        guard contextFetched.map({ Date().timeIntervalSince($0) > 30 * 60 }) ?? true else { return }
        refreshLensContext()
    }

    private func refreshLensContext() {
        guard let hub, hub.isOnline else { return }
        Task {
            guard let result = try? await hub.request("memory.context"),
                  let persona = result["persona"] as? String, let memory = result["memory"] as? String,
                  hub.isPaired else { return }
            let context = "\(persona)\n\n<dash_memory>\n\(memory)\n</dash_memory>"
            lensContext = context
            contextFetched = Date()
            try? FileManager.default.createDirectory(at: HubClient.cacheDir, withIntermediateDirectories: true)
            try? context.write(to: Self.contextURL, atomically: true, encoding: .utf8)
        }
    }

    /// Sends the oldest entries, then takes exactly those off the queue (by id), so anything logged while
    /// the request was out stays for the next batch.
    private func flush() {
        guard let hub, hub.isOnline, !pending.isEmpty, !flushing else { return }
        flushing = true
        let batch = Array(pending.prefix(Self.batchSize))
        let sent = Set(batch.compactMap { $0["id"] as? String })
        Task {
            let delivered = (try? await hub.request("memory.log", ["entries": batch])) != nil
            // Cleared before the follow-up flush below, which would otherwise see it still set and stop.
            flushing = false
            guard delivered else { return }
            let before = pending.count
            pending.removeAll { ($0["id"] as? String).map(sent.contains) ?? false }
            savePending()
            if pending.count < before { flush() }
        }
    }

    // MARK: Memory kept while unpaired

    /// While this Mac wasn't paired, "remember…" lines went into the local memory.md, which the hub never
    /// sees. Once it's online they go up once and the hub adds them to remember.md, skipping any it
    /// already has, and memory-uploaded.json records them so they aren't sent again.
    private func uploadLocalMemory() {
        guard let hub, hub.isOnline, !uploadingLocal else { return }
        let uploaded = Self.uploadedLines()
        let fresh = Self.localMemoryLines().filter { !uploaded.contains($0) }
        guard !fresh.isEmpty else { return }
        uploadingLocal = true
        Task {
            defer { uploadingLocal = false }
            guard let snapshot = try? await hub.request("memory.get") else { return }
            let remember = snapshot["remember"] as? String ?? ""
            // Sent as written: the hub adds each line to remember.md as-is (and skips ones it already has).
            enqueue(fresh.filter { !remember.contains($0) }.map { Self.entry(source: "note", kind: "remember", text: $0) })
            let all = Array(uploaded.union(fresh)).sorted()
            if let data = try? JSONSerialization.data(withJSONObject: all, options: .prettyPrinted) {
                try? data.write(to: Self.uploadedURL, options: .atomic)
            }
        }
    }

    /// The local memory.md's remembered lines, without the header or list markers. Read directly rather
    /// than through Personal.memory(), which would create the file.
    private static func localMemoryLines() -> [String] {
        guard let text = try? String(contentsOf: Personal.memoryURL, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { raw in
            var line = raw.trimmingCharacters(in: .whitespaces)
            // "Things you asked Dash to remember…" under the header (older files name the user instead).
            let isIntro = line.hasPrefix("Things ") && line.contains(" asked Dash to remember")
            guard !line.isEmpty, !line.hasPrefix("#"), !line.hasPrefix("<!--"), !isIntro else { return nil }
            if line.hasPrefix("- ") || line.hasPrefix("* ") { line = String(line.dropFirst(2)) }
            return line.isEmpty ? nil : line
        }
    }

    private static func uploadedLines() -> Set<String> {
        guard let data = try? Data(contentsOf: uploadedURL),
              let lines = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
        return Set(lines)
    }

    private func savePending() {
        try? FileManager.default.createDirectory(at: HubClient.cacheDir, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: pending) {
            try? data.write(to: Self.pendingURL, options: .atomic)
        }
    }

    // MARK: The Memory page

    func load() {
        guard let hub else { return }
        guard hub.isOnline else { error = hub.offlineMessage; return }
        loading = true
        Task {
            defer { loading = false }
            do {
                apply(try await hub.request("memory.get"))
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Removes one line from core, threads, remember or a day's journal.
    func forget(file: String, line: String, day: String? = nil) {
        guard let hub, hub.isOnline else { error = hub?.offlineMessage; return }
        var params: [String: Any] = ["file": file, "line": line]
        if let day { params["day"] = day }
        Task {
            do {
                apply(try await hub.request("memory.forget", params))
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func apply(_ result: [String: Any]) {
        snapshot = Snapshot(core: result["core"] as? String ?? "", selfNotes: result["self"] as? String ?? "",
                            threads: result["threads"] as? String ?? "",
                            remember: result["remember"] as? String ?? "",
                            journal: (result["journal"] as? [[String: Any]] ?? []).compactMap { entry in
                                guard let day = entry["day"] as? String, let text = entry["text"] as? String else { return nil }
                                return JournalEntry(day: day, text: text)
                            },
                            recent: result["recent"] as? String ?? "")
    }

    /// Sample data for `Dash --preview memory`.
    func showSample() {
        snapshot = Snapshot(
            core: "# Alex, right now\n\n## People\n- Roommate: Sam, snores, gets along fine\n## School\n- HIST2100A essay due Friday; worried about the thesis\n## This week\n- Midterm stretch; busy but managing",
            selfNotes: "# Dash, in his own words\n\n## Who I am\n- I'm Dash (he/him), Alex's chief of staff and confidant.\n## Running jokes and shared references\n- The history essay that ate October.",
            threads: "# Follow-ups\n\n- [ ] after 2026-10-30 · Ask how the HIST2100 exam went\n- [ ] after 2026-11-02 · Did the talk with Sam about quiet hours happen?",
            remember: "# Things to remember\n\n- 2026-10-14: earnings recaps lead with EPS",
            journal: [JournalEntry(day: "2026-10-27", text: "A long Tuesday. Alex spent the afternoon outlining the HIST2100 essay and sounded tired but steadier by the evening. About 20 lens questions on Spanish homework.")],
            recent: "- Tue 3:10 PM · chat \"History essay\": Outlined the essay; follow up Friday.")
    }
}
