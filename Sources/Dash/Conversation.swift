import AppKit
import SwiftUI

/// A conversation with one Claude Code session: the turns, live streaming, tool calls, and
/// write approvals. The ⌥A lens (`Session`) and the console chats build on this.
@MainActor
class Conversation: ObservableObject {
    struct ToolCall: Identifiable, Equatable, Codable {
        let id: String
        let name: String
        var done = false
        var failed = false
        /// The call's arguments as JSON text (Codable, and cheap to compare).
        var inputJSON = "{}"
        var output = ""
        /// The one-line gist shown beside the name, computed once when the call starts so streaming
        /// doesn't re-parse the arguments on every update.
        var summary = ""

        /// "Checking calendar" rather than "mcp__jarvis__calendar_get".
        var label: String { Tools.label(for: name) }

        var input: [String: Any] {
            (try? JSONSerialization.jsonObject(with: Data(inputJSON.utf8))) as? [String: Any] ?? [:]
        }

        static func json(_ input: [String: Any]) -> String {
            guard JSONSerialization.isValidJSONObject(input),
                  let data = try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])
            else { return "{}" }
            return String(decoding: data, as: UTF8.self)
        }
    }

    struct Turn: Identifiable, Equatable, Codable {
        enum Role: String, Codable { case user, assistant }
        var id = UUID()
        let role: Role
        var text: String
        var mode: Mode?
        var isError = false
        var tools: [ToolCall] = []
        /// Claude's reasoning, when the model streams it.
        var thinking = ""
        /// File names attached to a user message.
        var attachments: [String] = []
        /// The turn was stopped before Claude finished.
        var stopped = false
    }

    /// A write Claude wants to make, waiting on Approve or Deny.
    struct Approval: Identifiable {
        let request: PermissionRequest
        var id: String { request.id }
        var title: String { Tools.label(for: request.toolName) }
        /// The arguments worth showing, in a readable order (to/subject/body, title/start/end…).
        var fields: [(key: String, value: String)] { Tools.fields(request.input) }
    }

    enum Status { case idle, capturing, thinking, streaming }

    @Published var turns: [Turn] = []
    @Published var status: Status = .idle
    @Published var notice: String?
    @Published var approvals: [Approval] = []
    /// Stop was pressed and Claude Code hasn't wrapped up the turn yet.
    @Published var stopping = false
    /// The notice the Dash hub last sent for this chat, so clearing it there clears it here without
    /// also wiping a notice this Mac put up itself.
    var hubNotice: String?

    /// The Claude Code session holding this conversation. Nil until the first question,
    /// and reset whenever the conversation is.
    var claude: ClaudeSession?
    /// Bumped whenever the conversation is reset, so a request that was still
    /// running for the old conversation can't write into the new one.
    var generation = 0
    var task: Task<Void, Never>?
    /// Set after a tool call, so the text that follows starts a new paragraph.
    private var breakBeforeText = false

    var isBusy: Bool { status != .idle }

    var model: ClaudeModel {
        ClaudeModel.find(UserDefaults.standard.string(forKey: Prefs.modelID) ?? ClaudeModel.defaultID)
    }

    /// How this conversation starts Claude Code. Subclasses choose the prompt and tools.
    func makeClaude(effort: String) throws -> ClaudeSession {
        try ClaudeSession(model: model, effort: effort, system: Prompts.system)
    }

    /// Requests that are safe to grant without asking (e.g. editing Dash's memory file).
    func autoApproves(_ request: PermissionRequest) -> Bool { false }

    /// Whether a stopped or crashed Claude Code session can be picked up again with its context.
    /// Only console chats keep their history in Claude Code; the others start over.
    var isResumable: Bool { false }

    /// Called after every turn (finished, stopped or failed), once the conversation is idle again.
    func turnDidFinish(_ turn: Turn) {}

    /// Called when a turn fails with an error (not when it's stopped).
    func sendDidFail(_ error: Error) {}

    /// One-question conversations (the daily brief) close Claude Code once the reply is in,
    /// instead of leaving an idle process around.
    var closesAfterReply: Bool { false }

    func clear() {
        guard !isBusy else { return }
        generation += 1
        resetClaude()
        turns = []
        notice = nil
    }

    /// Appends the user's turn and streams Claude's reply into a new assistant turn.
    func send(_ content: [[String: Any]], display: Turn, effort: String = "medium") {
        guard !isBusy else { return }
        notice = nil
        turns.append(display)
        turns.append(Turn(role: .assistant, text: ""))
        let index = turns.count - 1

        let claude: ClaudeSession
        do {
            claude = try self.claude ?? makeClaude(effort: effort)
            self.claude = claude
        } catch {
            turns[index].text = error.localizedDescription
            turns[index].isError = true
            return
        }
        status = .thinking
        breakBeforeText = false

        let generation = self.generation
        stopping = false
        task = Task {
            do {
                let result = try await claude.send(content: content) { event in
                    guard generation == self.generation else { return }
                    self.handle(event, at: index, claude: claude)
                }
                guard generation == self.generation else { return }
                if turns[index].text.isEmpty { turns[index].text = result.text }

                if result.interrupted {
                    markStopped(at: index)
                } else if result.stopReason == "refusal" {
                    turns[index].text = "Claude declined to answer this one. Try rephrasing."
                    turns[index].isError = true
                } else if turns[index].text.isEmpty {
                    turns[index].text = "No answer came back. Try again."
                    turns[index].isError = true
                } else if result.stopReason == "max_tokens" {
                    turns[index].text += "\n\n*(Cut off at the length limit.)*"
                }
                if closesAfterReply { resetClaude() }
            } catch {
                guard generation == self.generation else { return }
                // The process is gone or unreliable now. A console chat can respawn it and resume
                // with its context; the other conversations start over on the next question.
                resetClaude()
                finishOpenTools(at: index)
                if !(error is CancellationError) { sendDidFail(error) }
                if error is CancellationError {
                    markStopped(at: index)
                } else if turns[index].text.isEmpty {
                    turns[index].text = error.localizedDescription
                    turns[index].isError = true
                } else {
                    // Keep what already streamed in; add the failure after it.
                    turns[index].text += "\n\n*(\(error.localizedDescription))*"
                }
            }
            finishOpenTools(at: index)
            approvals = []
            status = .idle
            stopping = false
            turnDidFinish(turns[index])
        }
    }

    /// Keeps whatever Claude had written and labels the turn as stopped.
    private func markStopped(at index: Int) {
        turns[index].stopped = true
        if turns[index].text.isEmpty && turns[index].tools.isEmpty { turns[index].text = "*(Stopped.)*" }
    }

    /// Tool calls that never got a result (stopped or failed turns) shouldn't spin forever.
    private func finishOpenTools(at index: Int) {
        for call in turns[index].tools.indices where !turns[index].tools[call].done {
            turns[index].tools[call].done = true
            turns[index].tools[call].failed = true
        }
    }

    private func handle(_ event: ClaudeEvent, at index: Int, claude: ClaudeSession) {
        status = .streaming
        switch event {
        case .text(let delta):
            if breakBeforeText && !turns[index].text.isEmpty { turns[index].text += "\n\n" }
            breakBeforeText = false
            turns[index].text += delta
        case .thinking(let delta):
            turns[index].thinking += delta
        case .toolStarted(let id, let name, let input):
            guard !turns[index].tools.contains(where: { $0.id == id }) else { return }
            turns[index].tools.append(ToolCall(id: id, name: name, inputJSON: ToolCall.json(input),
                                               summary: Tools.summary(name: name, input: input)))
            breakBeforeText = true
        case .toolFinished(let id, let isError, let output):
            if let call = turns[index].tools.firstIndex(where: { $0.id == id }) {
                turns[index].tools[call].done = true
                turns[index].tools[call].failed = isError
                turns[index].tools[call].output = output
            }
        case .permission(let request):
            if autoApproves(request) {
                claude.respond(to: request, allow: true)
            } else {
                approvals.append(Approval(request: request))
                // A card nobody sees leaves Claude waiting; bounce the Dock icon if Dash is in the background.
                if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
            }
        }
    }

    func decide(_ approval: Approval, allow: Bool, always: Bool = false) {
        approvals.removeAll { $0.id == approval.id }
        claude?.respond(to: approval.request, allow: allow, always: always)
    }

    /// Stops the current answer. Console chats ask Claude Code to interrupt, which keeps the
    /// session (and its memory of the conversation) alive; if it doesn't wrap up in a few
    /// seconds, or this isn't a resumable chat, the process is cancelled outright.
    func stop() {
        guard isBusy, !stopping else { return }
        if isResumable, let claude, claude.interrupt() {
            stopping = true
            approvals = []
            let generation = self.generation
            Task {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if generation == self.generation, self.stopping { self.task?.cancel() }
            }
        } else {
            task?.cancel()
        }
    }

    func resetClaude() {
        claude?.close()
        claude = nil
        approvals = []
    }

    func copyLastAnswer() {
        guard let text = turns.last(where: { $0.role == .assistant && !$0.isError })?.text else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// Friendly names for tool calls and their arguments.
enum Tools {
    static func label(for name: String) -> String {
        switch name.replacingOccurrences(of: "mcp__jarvis__", with: "") {
        case "calendar_get": "Checking calendar"
        case "calendar_create": "Add calendar event"
        case "calendar_delete": "Delete calendar event"
        case "email_read": "Reading inbox"
        case "email_send": "Send email"
        case "email_delete": "Delete email"
        case "weather_get": "Checking weather"
        case "web_search": "Searching the web"
        case "file_read", "Read": "Reading a file"
        case "file_write", "Write": "Write file"
        case "Edit": "Edit file"
        case "Glob", "Grep": "Looking through files"
        case "docs_read_section": "Reading lecture notes"
        case "docs_append_notes": "Add to lecture notes"
        case "docs_replace_section": "Replace lecture notes"
        case "WebSearch": "Searching the web"
        case "WebFetch": "Reading a web page"
        case let robinhood where robinhood.hasPrefix("mcp__robinhood__get_"):
            "Robinhood: " + robinhood.dropFirst("mcp__robinhood__get_".count).replacingOccurrences(of: "_", with: " ")
        case let other: other
        }
    }

    private static let order = ["to", "subject", "body", "title", "start", "end", "description",
                                "file_path", "path", "course_code", "date", "content", "new_string", "text"]

    static func fields(_ input: [String: Any]) -> [(key: String, value: String)] {
        input.map { (key: $0.key, value: "\($0.value)") }
            .sorted { (order.firstIndex(of: $0.key) ?? 99, $0.key) < (order.firstIndex(of: $1.key) ?? 99, $1.key) }
    }
}

// Saved chats outlive app versions, so decoding tolerates fields a file doesn't have yet (and
// ignores ones it has that this version dropped). Only the fields a turn can't exist without are required.
extension Conversation.ToolCall {
    enum CodingKeys: String, CodingKey { case id, name, done, failed, inputJSON, output, summary }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id), name: try c.decode(String.self, forKey: .name),
                  done: try c.decodeIfPresent(Bool.self, forKey: .done) ?? true,
                  failed: try c.decodeIfPresent(Bool.self, forKey: .failed) ?? false,
                  inputJSON: try c.decodeIfPresent(String.self, forKey: .inputJSON) ?? "{}",
                  output: try c.decodeIfPresent(String.self, forKey: .output) ?? "",
                  summary: try c.decodeIfPresent(String.self, forKey: .summary) ?? "")
    }
}

extension Conversation.Turn {
    enum CodingKeys: String, CodingKey {
        case id, role, text, mode, isError, tools, thinking, attachments, stopped
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID(),
                  role: try c.decode(Role.self, forKey: .role), text: try c.decode(String.self, forKey: .text),
                  mode: try c.decodeIfPresent(Mode.self, forKey: .mode),
                  isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false,
                  tools: try c.decodeIfPresent([Conversation.ToolCall].self, forKey: .tools) ?? [],
                  thinking: try c.decodeIfPresent(String.self, forKey: .thinking) ?? "",
                  attachments: try c.decodeIfPresent([String].self, forKey: .attachments) ?? [],
                  stopped: try c.decodeIfPresent(Bool.self, forKey: .stopped) ?? false)
    }
}
