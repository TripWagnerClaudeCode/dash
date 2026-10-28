import Foundation

struct ClaudeModel: Identifiable, Hashable {
    let id: String
    let name: String
    let blurb: String
    let supportsEffort: Bool

    static let opus = ClaudeModel(id: "claude-opus-5-5", name: "Opus 5.5", blurb: "best quality", supportsEffort: true)
    static let sonnet = ClaudeModel(id: "claude-sonnet-5-5", name: "Sonnet 5.5", blurb: "faster", supportsEffort: true)
    static let haiku = ClaudeModel(id: "claude-haiku-4-5", name: "Haiku 4.5", blurb: "fastest, lightest on limits",
                                   supportsEffort: false)

    static let all = [opus, sonnet, haiku]
    static let defaultID = opus.id

    static func find(_ id: String) -> ClaudeModel {
        all.first { $0.id == id } ?? opus
    }
}

struct TurnResult {
    var text: String
    var stopReason: String?
    /// True when the turn ended because Dash asked Claude Code to stop.
    var interrupted = false
}

/// What a Claude Code session may use. `.lens` is the original screen helper: no tools at all.
/// Console sessions add jarvis (email, calendar, weather, search…) and file tools. Anything
/// not in `allowedTools` comes back to Dash as a permission request instead of just running.
struct ClaudeProfile {
    var tools: [String] = []
    var jarvis = false
    var allowedTools: [String] = []
    var disallowedTools: [String] = []
    var addDirs: [String] = []
    /// Extra MCP servers by name (e.g. the advisor's read-only Robinhood relay).
    var mcpServers: [String: Any] = [:]
    /// Keep Claude Code's own system prompt and append Dash's text to it (console chats), rather
    /// than replacing it (the lens and the other single-purpose helpers).
    var keepDefaultPrompt = false
    /// "acceptEdits", "plan"… nil leaves Claude Code's default.
    var permissionMode: String?

    static let lens = ClaudeProfile()

    /// jarvis tools that only read, so they run without asking.
    static let jarvisReads = ["calendar_get", "email_read", "weather_get", "web_search", "file_read",
                              "docs_read_section"].map { "mcp__jarvis__\($0)" }
    /// Recording state lives in Dash's own jarvis process (see JarvisClient), so chats never
    /// touch it, and the headless browser isn't part of the console.
    static let jarvisBlocked = ["lecture_start", "lecture_stop", "lecture_status", "lecture_get_new_transcript",
                                "lecture_bootstrap_course", "browser_navigate", "browser_interact",
                                "browser_screenshot"].map { "mcp__jarvis__\($0)" }

    static func console(addDirs: [String] = []) -> ClaudeProfile {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ClaudeProfile(tools: chatTools,
                             jarvis: true,
                             allowedTools: jarvisReads + ["Read", "Glob", "Grep", "WebSearch", "Task"],
                             disallowedTools: jarvisBlocked,
                             addDirs: ["\(home)/Documents", "\(home)/Desktop", "\(home)/Downloads",
                                       "\(home)/BrightspaceToDo"] + addDirs,
                             keepDefaultPrompt: true)
    }

    /// What a console chat can do. Reads and web search run at once; Bash (anything beyond
    /// read-only commands), Edit/Write, WebFetch and NotebookEdit come back as Approve/Deny cards.
    static let chatTools = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "WebFetch",
                            "NotebookEdit", "Task"]
}

/// A tool call Claude wants to make that isn't pre-approved. Dash shows it as an
/// Approve/Deny card and answers with `ClaudeSession.respond`.
struct PermissionRequest {
    let id: String
    let toolName: String
    let displayName: String
    let input: [String: Any]
    /// Rules Claude Code offers for "always allow this" (already scoped to this session).
    var suggestions: [[String: Any]] = []
}

enum ClaudeEvent {
    case text(String)
    case thinking(String)
    case toolStarted(id: String, name: String, input: [String: Any])
    case toolFinished(id: String, isError: Bool, output: String)
    case permission(PermissionRequest)
}

enum ClaudeCLIError: LocalizedError {
    case notInstalled
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .notInstalled:
            "Couldn't find the claude command. Dash runs on Claude Code, so install it and sign in with `claude` in Terminal."
        case .failed(let message):
            message
        }
    }
}

/// One headless Claude Code session (`claude -p`, streaming JSON in and out), kept open for a
/// whole conversation so follow-ups only send the new message. It runs on the Claude
/// subscription Claude Code is signed in with: API-key variables are stripped from its
/// environment, and it never loads user settings, plugins, or MCP servers beyond what its
/// `ClaudeProfile` names.
@MainActor
final class ClaudeSession {
    fileprivate let process = Process()
    private let input = Pipe()
    /// Writes to claude's stdin happen here, in order: a message with a screenshot is a megabyte or two,
    /// and a full pipe would otherwise block the main thread until claude reads it.
    private let writer = DispatchQueue(label: "dash.claude-stdin")
    private let output = Pipe()
    private let errors = Pipe()
    private var buffer = Data()
    private var stderrText = ""
    private var onEvent: ((ClaudeEvent) -> Void)?
    private var configFile: URL?
    private var continuation: CheckedContinuation<TurnResult, Error>?
    private var interruptRequested = false

    /// Every live session, so quitting Dash can close them instead of leaving `claude` and its
    /// MCP children running on their own.
    private final class WeakSession {
        weak var session: ClaudeSession?
        init(_ session: ClaudeSession) { self.session = session }
    }
    private static var registry: [WeakSession] = []

    /// Closes every live session. At quit the process exits right after, so the SIGKILL fallback in
    /// `close()` would never get to run; wait briefly here and kill whatever ignored SIGTERM.
    static func closeAll() {
        let sessions = registry.compactMap(\.session)
        for session in sessions { session.close() }
        registry.removeAll()
        let deadline = Date().addingTimeInterval(1)
        while sessions.contains(where: { $0.process.isRunning }) && Date() < deadline { usleep(25_000) }
        for session in sessions where session.process.isRunning { kill(session.process.processIdentifier, SIGKILL) }
    }

    /// Where the claude binary lives. A Dock-launched app gets a bare PATH, so check the
    /// usual install spots before asking a login shell.
    static let executable: URL? = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["\(home)/.local/bin/claude", "/opt/homebrew/bin/claude",
                          "/usr/local/bin/claude", "\(home)/.claude/local/claude"]
        if let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return URL(fileURLWithPath: path)
        }
        let shell = Process()
        let pipe = Pipe()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "command -v claude"]
        shell.standardOutput = pipe
        shell.standardError = FileHandle.nullDevice
        guard (try? shell.run()) != nil else { return nil }
        shell.waitUntilExit()
        let path = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return FileManager.default.isExecutableFile(atPath: path) ? URL(fileURLWithPath: path) : nil
    }()

    /// Starts the claude process right away, so its startup overlaps with taking the screenshot.
    /// `sessionID` makes the conversation resumable: a new one is created under that ID, or with
    /// `resume` the existing one is continued (the history lives in Claude Code, not in Dash).
    init(model: ClaudeModel, effort: String, system: String, profile: ClaudeProfile = .lens,
         sessionID: String? = nil, resume: Bool = false) throws {
        guard let executable = Self.executable else { throw ClaudeCLIError.notInstalled }
        var arguments = ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
                         "--include-partial-messages", "--verbose",
                         "--model", model.id,
                         profile.keepDefaultPrompt ? "--append-system-prompt" : "--system-prompt", system,
                         "--tools", profile.tools.joined(separator: ","),
                         "--strict-mcp-config", "--setting-sources", ""]
        if let sessionID {
            arguments += [resume ? "--resume" : "--session-id", sessionID]
        } else {
            arguments.append("--no-session-persistence")
        }
        if let mode = profile.permissionMode { arguments += ["--permission-mode", mode] }
        if model.supportsEffort { arguments += ["--effort", effort] }
        if profile.jarvis { arguments += ["--mcp-config", JarvisClient.mcpConfigJSON] }
        if !profile.mcpServers.isEmpty {
            // Written to a private file rather than the command line, since it can carry a secret.
            let url = Personal.supportDir.appendingPathComponent("mcp-\(UUID().uuidString).json")
            let data = try JSONSerialization.data(withJSONObject: ["mcpServers": profile.mcpServers])
            FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])
            configFile = url
            arguments += ["--mcp-config", url.path]
        }
        if !profile.allowedTools.isEmpty { arguments += ["--allowedTools", profile.allowedTools.joined(separator: ",")] }
        if !profile.disallowedTools.isEmpty {
            arguments += ["--disallowedTools", profile.disallowedTools.joined(separator: ",")]
        }
        for dir in profile.addDirs where FileManager.default.fileExists(atPath: dir) { arguments += ["--add-dir", dir] }
        // Tool calls that aren't pre-approved come back over stdout as control requests.
        if profile.jarvis || !profile.tools.isEmpty || !profile.mcpServers.isEmpty {
            arguments += ["--permission-prompt-tool", "stdio"]
        }

        var environment = ProcessInfo.processInfo.environment
        environment["ANTHROPIC_API_KEY"] = nil
        environment["ANTHROPIC_AUTH_TOKEN"] = nil
        // Dash keeps its own memory file; don't let Claude Code write a second, hidden one.
        environment["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        environment["PATH"] = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin",
                               environment["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")

        // An empty working directory, so no project CLAUDE.md gets pulled in.
        let workDir = Personal.supportDir

        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = workDir
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors

        // DispatchQueue.main keeps chunks in order, which separate Tasks wouldn't guarantee.
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.readAvailable()
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.receive(data) } }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.readAvailable()
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.appendStderr(data) }
            }
        }
        process.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.processEnded(status: status) } }
        }
        try process.run()
        Self.registry.removeAll { $0.session == nil }
        Self.registry.append(WeakSession(self))
    }

    private func appendStderr(_ data: Data) {
        stderrText += String(decoding: data, as: UTF8.self)
        if stderrText.count > 20_000 { stderrText = String(stderrText.suffix(10_000)) }
    }

    /// Sends one user message and streams the reply (text, tool calls, permission requests)
    /// through `onEvent`.
    func send(content: [[String: Any]], onEvent: @escaping (ClaudeEvent) -> Void) async throws -> TurnResult {
        guard continuation == nil else { throw ClaudeCLIError.failed("Still answering the last question.") }
        let message: [String: Any] = ["type": "user", "message": ["role": "user", "content": content]]
        let line = try Self.line(message)
        self.onEvent = onEvent
        interruptRequested = false

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                guard process.isRunning else {
                    return finish(.failure(ClaudeCLIError.failed(exitMessage())))
                }
                writeLine(line) { [weak self] in
                    guard let self else { return }
                    finish(.failure(ClaudeCLIError.failed(exitMessage())))
                }
            }
        } onCancel: {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.close()
                    self.finish(.failure(CancellationError()))
                }
            }
        }
    }

    /// Answers a permission request. Denying tells Claude why, so it can say so in its reply.
    /// `always` also applies Claude Code's suggested allow rule for the rest of this session.
    func respond(to request: PermissionRequest, allow: Bool, always: Bool = false) {
        var decision: [String: Any] = allow
            ? ["behavior": "allow", "updatedInput": request.input]
            : ["behavior": "deny", "message": "The user denied this in Dash. Don't retry it unless they ask."]
        if allow, always, !request.suggestions.isEmpty { decision["updatedPermissions"] = request.suggestions }
        write(["type": "control_response",
               "response": ["subtype": "success", "request_id": request.id, "response": decision]])
    }

    /// Asks Claude Code to stop the current turn. The session stays alive and keeps its context;
    /// the turn then ends with an error-flavored `result`, which `handle` reports as interrupted.
    /// Returns false when there's nothing running to interrupt.
    @discardableResult
    func interrupt() -> Bool {
        guard continuation != nil, process.isRunning else { return false }
        interruptRequested = true
        write(["type": "control_request", "request_id": "dash-int-\(UUID().uuidString)",
               "request": ["subtype": "interrupt"]])
        return true
    }

    var isTurnActive: Bool { continuation != nil }

    private func write(_ object: [String: Any]) {
        guard process.isRunning, let line = try? Self.line(object) else { return }
        writeLine(line)
    }

    /// Queues one line for claude's stdin; `failed` runs on the main actor if the write fails.
    private func writeLine(_ line: Data, failed: (@MainActor () -> Void)? = nil) {
        let handle = input.fileHandleForWriting
        writer.async {
            do {
                try handle.write(contentsOf: line)
            } catch {
                guard let failed else { return }
                DispatchQueue.main.async { MainActor.assumeIsolated { failed() } }
            }
        }
    }

    /// Plain one-off question with no tools: starts a session, asks, closes it.
    static func ask(_ prompt: String, system: String, model: ClaudeModel = .sonnet,
                    effort: String = "low") async throws -> String {
        let session = try ClaudeSession(model: model, effort: effort, system: system)
        defer { session.close() }
        let result = try await session.send(content: [["type": "text", "text": prompt]]) { _ in }
        return result.text
    }

    private static func line(_ object: [String: Any]) throws -> Data {
        var data = try JSONSerialization.data(withJSONObject: object)
        data.append(0x0A)
        return data
    }

    func close() {
        if let configFile { try? FileManager.default.removeItem(at: configFile) }
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
        // After any writes still queued, so none of them lands on a closed (or reused) descriptor.
        let handle = input.fileHandleForWriting
        writer.async { try? handle.close() }
        if process.isRunning {
            process.terminate()
            // A claude stuck mid-turn can ignore SIGTERM; make sure it doesn't outlive us.
            let process = process
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            if let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                handle(event)
            }
        }
    }

    private func handle(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "stream_event":
            guard let inner = event["event"] as? [String: Any],
                  inner["type"] as? String == "content_block_delta",
                  let delta = inner["delta"] as? [String: Any]
            else { return }
            switch delta["type"] as? String {
            case "text_delta": if let text = delta["text"] as? String { onEvent?(.text(text)) }
            case "thinking_delta": if let text = delta["thinking"] as? String { onEvent?(.thinking(text)) }
            default: break
            }
        case "assistant":
            let blocks = (event["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in blocks where block["type"] as? String == "tool_use" {
                guard let id = block["id"] as? String, let name = block["name"] as? String else { continue }
                onEvent?(.toolStarted(id: id, name: name, input: block["input"] as? [String: Any] ?? [:]))
            }
        case "user":
            let blocks = (event["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in blocks where block["type"] as? String == "tool_result" {
                guard let id = block["tool_use_id"] as? String else { continue }
                onEvent?(.toolFinished(id: id, isError: block["is_error"] as? Bool ?? false,
                                       output: Self.resultText(block["content"])))
            }
        case "rate_limit_event":
            // Every request reports subscription usage; the tracker on Today shows it.
            if let info = event["rate_limit_info"] as? [String: Any] { Usage.shared.update(from: info) }
        case "control_request":
            guard let id = event["request_id"] as? String, let request = event["request"] as? [String: Any]
            else { return }
            guard request["subtype"] as? String == "can_use_tool", let tool = request["tool_name"] as? String else {
                // Anything else (hooks, MCP elicitation…) isn't supported here. Answer, so Claude Code
                // doesn't wait forever for a reply that would never come.
                write(["type": "control_response",
                       "response": ["subtype": "error", "request_id": id,
                                    "error": "Dash doesn't support this request."]])
                return
            }
            // "Always allow" should last for this conversation only, never get saved to settings files.
            // Keep only narrow allow rules. Claude Code also suggests mode changes (accept all edits) and
            // whole directories, which are far broader than "always allow this".
            let suggestions = (request["permission_suggestions"] as? [[String: Any]] ?? [])
                .filter { $0["type"] as? String == "addRules" && $0["behavior"] as? String == "allow" }
                .map { rule -> [String: Any] in
                    var rule = rule
                    rule["destination"] = "session"
                    return rule
                }
            let permission = PermissionRequest(id: id, toolName: tool,
                                               displayName: request["display_name"] as? String ?? tool,
                                               input: request["input"] as? [String: Any] ?? [:],
                                               suggestions: suggestions)
            // Nobody is listening between turns; refuse rather than leave Claude hanging.
            if let onEvent { onEvent(.permission(permission)) } else { respond(to: permission, allow: false) }
        case "result":
            let text = event["result"] as? String ?? ""
            if interruptRequested, event["is_error"] as? Bool == true {
                finish(.success(TurnResult(text: text, stopReason: "interrupted", interrupted: true)))
            } else if event["is_error"] as? Bool == true {
                let detail = (event["errors"] as? [String])?.joined(separator: " ") ?? ""
                finish(.failure(ClaudeCLIError.failed(text.isEmpty ? (detail.isEmpty ? "Claude Code reported an error." : detail) : text)))
            } else {
                finish(.success(TurnResult(text: text, stopReason: event["stop_reason"] as? String)))
            }
        default:
            break
        }
    }

    /// A tool_result's content is a string, or a list of text blocks.
    private static func resultText(_ content: Any?) -> String {
        let text: String
        if let string = content as? String {
            text = string
        } else if let blocks = content as? [[String: Any]] {
            text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
        } else {
            text = ""
        }
        return text.count > 30_000 ? String(text.prefix(30_000)) + "\n… (output truncated)" : text
    }

    private func processEnded(status: Int32) {
        if continuation != nil { Log.write("claude exited mid-turn (status \(status)): \(stderrText.suffix(200))") }
        finish(.failure(ClaudeCLIError.failed(exitMessage())))
    }

    private func exitMessage() -> String {
        let detail = stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = detail.lowercased()
        if ["/login", "not logged in", "please log in", "authenticat", "oauth", "invalid api key"].contains(where: lower.contains) {
            return "Claude Code isn't signed in. Run `claude` in Terminal and log in, then try again."
        }
        return detail.isEmpty ? "Claude Code stopped unexpectedly." : "Claude Code: \(detail.suffix(300))"
    }

    private func finish(_ result: Result<TurnResult, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        onEvent = nil
        interruptRequested = false
        continuation.resume(with: result)
    }
}
