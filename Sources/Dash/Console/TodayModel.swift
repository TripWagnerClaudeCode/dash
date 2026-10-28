import AppKit
import SwiftUI

enum Load<Value> {
    case idle, loading, loaded(Value), failed(String)

    var value: Value? { if case .loaded(let value) = self { value } else { nil } }
}

struct CalendarEvent: Identifiable {
    let id: String
    let title: String
    let start: Date
    let end: Date?
    let allDay: Bool
    let place: String

    /// "HIST2100A" from "HIST2100A: Popes and Emperors".
    var courseCode: String? {
        let head = title.split(separator: ":").first.map(String.init) ?? ""
        return head.range(of: #"^[A-Z]{2,5}\d{3,4}[A-Z]?$"#, options: .regularExpression) != nil ? head : nil
    }
}

struct MailItem: Identifiable {
    let id: String
    let from: String
    let subject: String
}

/// Data for the Today page, fetched straight from Dash's jarvis (no Claude in the loop),
/// plus the "Brief me" overview, which Claude writes from that data.
@MainActor
final class TodayModel: ObservableObject {
    @Published var events: Load<[CalendarEvent]> = .idle
    @Published var weather: Load<String> = .idle
    @Published var inbox: Load<[MailItem]> = .idle
    @Published var lastRefresh: Date?
    let brief = BriefConversation()
    let todos = ToDoList()
    let deadlines = DeadlinesModel()

    private let jarvis: JarvisClient
    private var raw: [String: String] = [:]
    /// Set once this Mac is paired with the Dash hub: then Today shows the hub's data (the same the
    /// phone sees) and the hub writes the brief. Unpaired, Today loads everything itself as before.
    private(set) var hub: HubClient?
    private var hubCanBrief = false

    static let brightspaceURL = Personal.home.appendingPathComponent("BrightspaceToDo/todo.md")

    init(jarvis: JarvisClient) {
        self.jarvis = jarvis
    }

    var usesHub: Bool { hub?.isPaired == true }

    func useHub(_ hub: HubClient) {
        self.hub = hub
        hub.on("today") { [weak self] snapshot in self?.apply(snapshot) }
        todos.useHub(hub)
        deadlines.useHub(hub)
    }

    var isLoading: Bool {
        [events.isLoading, weather.isLoading, inbox.isLoading].contains(true)
    }

    /// Refreshes if it's been a while; Today calls this whenever it appears.
    func refreshIfStale() {
        if usesHub {
            askHub("today.get")
            return
        }
        if lastRefresh.map({ Date().timeIntervalSince($0) > 600 }) ?? true { refresh() }
    }

    func refresh() {
        if usesHub {
            askHub("today.refresh")
            return
        }
        guard !isLoading else { return }
        lastRefresh = Date()
        // Forget the last fetch, so a failed refresh can't feed old data to the brief.
        raw = [:]
        events = .loading
        weather = .loading
        inbox = .loading
        Task {
            async let calendarText = fetch("calendar_get", ["days": 7])
            async let weatherText = fetch("weather_get")
            async let inboxText = fetch("email_read", ["n": 8])
            let (calendar, weatherResult, mail) = await (calendarText, weatherText, inboxText)
            events = calendar.map(Self.parseEvents)
            weather = weatherResult
            inbox = mail.map(Self.parseInbox)
        }
    }

    /// Whether the brief has something to work from: tiles are done loading and at least one loaded.
    var canBrief: Bool {
        if usesHub { return hub?.isOnline == true && hubCanBrief }
        return !isLoading && !brief.isBusy && !raw.isEmpty
    }

    /// Writes the daily overview from what the tiles loaded.
    func briefMe() {
        if usesHub {
            askHub("today.brief")
            return
        }
        guard canBrief else { return }
        let brightspace = (try? String(contentsOf: Self.brightspaceURL, encoding: .utf8)) ?? "(no to-do file)"
        // Event and message ids mean nothing to the brief; dropping them trims the prompt.
        let calendar = raw["calendar_get"].map(Self.stripIDs) ?? "(couldn't load)"
        let inbox = raw["email_read"].map(Self.stripIDs) ?? "(couldn't load)"
        let prompt = """
        Right now it is \(Personal.now).

        <calendar_next_7_days>
        \(calendar)
        </calendar_next_7_days>

        <my_todo_list>
        \(todos.summary)
        </my_todo_list>

        <brightspace_todo>
        \(brightspace)
        </brightspace_todo>

        <weather>
        \(raw["weather_get"] ?? "(couldn't load)")
        </weather>

        <recent_inbox>
        \(inbox)
        </recent_inbox>

        Write today's overview.
        """
        brief.clear()
        brief.send([["type": "text", "text": prompt]], display: .init(role: .user, text: ""), effort: "low")
    }

    private func fetch(_ tool: String, _ arguments: [String: Any] = [:]) async -> Load<String> {
        do {
            let text = try await jarvis.call(tool, arguments)
            // jarvis reports Google auth trouble as plain text rather than an error.
            let lower = text.lowercased()
            if lower.contains("invalid_grant") || lower.contains("token has been expired") {
                return .failed("Google sign-in expired. Delete ~/.jarvis/token.json and run any jarvis email or calendar tool in Claude Code to sign in again.")
            }
            if lower.hasPrefix("failed to") || lower.contains("credentials.json") { return .failed(text) }
            raw[tool] = text
            return .loaded(text)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    // MARK: From the hub

    /// Asks the hub to do something; its answer and any later changes arrive as `today` snapshots.
    private func askHub(_ type: String) {
        guard let hub, hub.isOnline else { return }
        Task {
            do {
                let result = try await hub.request(type)
                // today.get answers with the snapshot itself.
                if type == "today.get" { apply(result) }
            } catch {
                Log.write("hub \(type) failed: \(error.localizedDescription)")
            }
        }
    }

    /// Shows a `today` snapshot from the hub (hub/src/today.ts `snapshot()`), in the same types the
    /// Today page uses for data loaded on this Mac.
    func apply(_ snapshot: [String: Any]) {
        events = Self.load(snapshot["events"]) { value in
            (value as? [[String: Any]] ?? []).compactMap { entry -> CalendarEvent? in
                guard let start = HubClient.date(entry["start"]) else { return nil }
                return CalendarEvent(id: entry["id"] as? String ?? UUID().uuidString, title: entry["title"] as? String ?? "",
                                     start: start, end: HubClient.date(entry["end"]), allDay: entry["allDay"] as? Bool ?? false,
                                     place: entry["place"] as? String ?? "")
            }
        }
        weather = Self.load(snapshot["weather"]) { $0 as? String ?? "" }
        inbox = Self.load(snapshot["inbox"]) { value in
            (value as? [[String: Any]] ?? []).map { entry in
                MailItem(id: entry["id"] as? String ?? UUID().uuidString, from: entry["from"] as? String ?? "",
                         subject: entry["subject"] as? String ?? "")
            }
        }
        lastRefresh = HubClient.date(snapshot["refreshed"])
        let remote = snapshot["brief"] as? [String: Any] ?? [:]
        hubCanBrief = remote["canBrief"] as? Bool ?? false
        brief.show(text: remote["text"] as? String ?? "", isError: remote["isError"] as? Bool ?? false,
                   busy: remote["busy"] as? Bool ?? false)
    }

    private static func load<Value>(_ entry: Any?, _ decode: (Any?) -> Value) -> Load<Value> {
        let entry = entry as? [String: Any] ?? [:]
        switch entry["state"] as? String {
        case "loading": return .loading
        case "loaded": return .loaded(decode(entry["value"]))
        case "failed": return .failed(entry["error"] as? String ?? "Couldn't load.")
        default: return .idle
        }
    }

    /// Removes " (id: …)" tags and the invisible padding characters newsletters stuff into previews.
    static func stripIDs(_ text: String) -> String {
        text.replacingOccurrences(of: #" \(id: [^)]+\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "[\u{200B}\u{200C}\u{200D}\u{00A0}\u{034F}\u{FEFF}]", with: "", options: .regularExpression)
            .replacingOccurrences(of: " {2,}", with: " ", options: .regularExpression)
    }

    // MARK: Parsing jarvis output

    private static let isoFormatter = ISO8601DateFormatter()
    private static let dayFormatter: DateFormatter = {
        let format = DateFormatter()
        format.dateFormat = "yyyy-MM-dd"
        return format
    }()

    static func parseEvents(_ text: String) -> [CalendarEvent] {
        entries(in: text).compactMap { lines in
            guard let first = lines.first, lines.count >= 2 else { return nil }
            var title = first
            var id = UUID().uuidString
            if let range = first.range(of: #" \(id: [^)]+\)$"#, options: .regularExpression) {
                id = String(first[range].dropFirst(6).dropLast())
                title = String(first[..<range.lowerBound])
            }
            let times = lines[1].components(separatedBy: " → ")
            guard let start = date(times[0]) else { return nil }
            return CalendarEvent(id: id, title: title, start: start,
                                 end: times.count > 1 ? date(times[1]) : nil,
                                 allDay: !times[0].contains("T"),
                                 place: lines.count > 2 ? lines[2] : "")
        }
    }

    static func parseInbox(_ text: String) -> [MailItem] {
        entries(in: text).compactMap { lines in
            guard let first = lines.first, first.hasPrefix("From: ") else { return nil }
            var from = String(first.dropFirst(6))
            var id = UUID().uuidString
            if let range = from.range(of: #" \(id: [^)]+\)$"#, options: .regularExpression) {
                id = String(from[range].dropFirst(6).dropLast())
                from = String(from[..<range.lowerBound])
            }
            // "Name <address>" → "Name"
            if let angle = from.firstIndex(of: "<"), angle > from.startIndex {
                from = from[..<angle].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            }
            let subject = lines.first { $0.hasPrefix("Subject: ") }.map { String($0.dropFirst(9)) } ?? "(no subject)"
            return MailItem(id: id, from: from, subject: subject)
        }
    }

    /// Splits jarvis's "1. …\n   …\n2. …" lists into the lines of each entry.
    private static func entries(in text: String) -> [[String]] {
        var result: [[String]] = []
        for line in text.components(separatedBy: "\n") {
            if let range = line.range(of: #"^\d+\. "#, options: .regularExpression) {
                result.append([String(line[range.upperBound...])])
            } else if !result.isEmpty {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { result[result.count - 1].append(trimmed) }
            }
        }
        return result
    }

    private static func date(_ string: String) -> Date? {
        let trimmed = string.trimmingCharacters(in: .whitespaces)
        return isoFormatter.date(from: trimmed) ?? dayFormatter.date(from: trimmed)
    }
}

extension Load {
    var isLoading: Bool { if case .loading = self { true } else { false } }

    func map<T>(_ transform: (Value) -> T) -> Load<T> {
        switch self {
        case .idle: .idle
        case .loading: .loading
        case .loaded(let value): .loaded(transform(value))
        case .failed(let message): .failed(message)
        }
    }
}

/// No tools: Claude only writes the overview from the data Dash hands it.
@MainActor
final class BriefConversation: Conversation {
    override var closesAfterReply: Bool { true }

    override func makeClaude(effort: String) throws -> ClaudeSession {
        try ClaudeSession(model: .sonnet, effort: effort,
                          system: Prompts.brief + "\n\n" + Personal.personalBackground)
    }

    /// Shows a brief the hub wrote (or is writing), keeping the turn's identity so streaming doesn't flicker.
    func show(text: String, isError: Bool, busy: Bool) {
        if text.isEmpty && !busy {
            if !turns.isEmpty { turns = [] }
        } else {
            var turn = turns.first(where: { $0.role == .assistant }) ?? Turn(role: .assistant, text: "")
            turn.text = text
            turn.isError = isError
            turns = [turn]
        }
        status = busy ? .streaming : .idle
    }
}
