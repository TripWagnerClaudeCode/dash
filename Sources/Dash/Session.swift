import AppKit
import SwiftUI

/// The ⌥A lens: one screenshot plus the conversation about it, in the floating panel.
@MainActor
final class Session: Conversation {
    @Published var capture: Capture?
    @Published var needsPermission = false
    /// Quiz mode: ⌥A answers every visible question tersely, on the quiz model, with an optional countdown.
    @Published var quizMode = false
    @Published var quizDeadline: Date?

    /// Wired up by AppDelegate.
    var hide: () -> Void = {}
    var recapture: () -> Void = {}
    var recaptureAppending: () -> Void = {}
    var setOpacity: (Double) -> Void = { _ in }
    var openSettings: () -> Void = {}
    var openConsole: () -> Void = {}
    var resetPosition: () -> Void = {}
    var snapOverDock: () -> Void = {}

    /// Whether `claude` has already been sent the current screenshot.
    private var imageSent = false
    /// The effort `claude` was started with; `--effort` is fixed for the life of the process.
    private var claudeEffort: String?

    override func resetClaude() {
        super.resetClaude()
        imageSent = false
        claudeEffort = nil
    }

    /// Quiz mode swaps in the faster quiz model and adds the authorization context to the prompt.
    override func makeClaude(effort: String) throws -> ClaudeSession {
        claudeEffort = effort
        guard quizMode else {
            // The lens knows the user too (core memory from the hub), but keeps to what's on screen.
            let system = MemoryModel.shared.lensContext.map { "\(Prompts.system)\n\n\($0)" } ?? Prompts.system
            return try ClaudeSession(model: model, effort: effort, system: system)
        }
        let quizModel = ClaudeModel.find(UserDefaults.standard.string(forKey: Prefs.quizModelID) ?? ClaudeModel.sonnet.id)
        return try ClaudeSession(model: quizModel, effort: effort, system: Prompts.system + Prompts.quizContext)
    }

    /// Each answer goes into Dash's memory as one line: what was asked, where, and the start of the answer.
    /// Quiz mode only notes that a quiz happened.
    override func turnDidFinish(_ turn: Turn) {
        guard turn.role == .assistant, !turn.isError, !turn.text.isEmpty, turns.count >= 2 else { return }
        let asked = turns[turns.count - 2]
        let place = capture.map { "\($0.appName): \($0.windowTitle)" } ?? "no screenshot"
        if quizMode {
            MemoryModel.shared.log(source: "lens", kind: "quiz", text: "Quiz mode on \(place)")
            return
        }
        let mode = asked.mode ?? .ask
        let question = asked.text.isEmpty ? mode.label : "\(mode.label): \(asked.text)"
        let answer = turn.text.count > 300 ? "\(turn.text.prefix(300))…" : turn.text
        MemoryModel.shared.log(source: "lens", kind: "question", text: "\(question) [\(place)] → \(answer)")
    }

    func setQuizMode(_ on: Bool, minutes: Int? = nil) {
        guard !isBusy else { return }
        if on != quizMode { generation += 1; resetClaude(); turns = []; capture = nil }
        quizMode = on
        quizDeadline = on ? minutes.map { Date().addingTimeInterval(Double($0) * 60) } : nil
        notice = nil
    }

    /// Captures the window and immediately asks for the answer. With `append`, the screenshot joins
    /// the current conversation (a reading passage on one screen, questions on the next) instead of replacing it.
    func captureWindow(of app: NSRunningApplication?, append: Bool = false) async {
        let append = append && claude != nil && !isBusy
        // Reset right away so nothing from the previous conversation lingers, and
        // remember which capture this is so an overlapping one can supersede it.
        generation += 1
        let generation = self.generation
        if !append {
            task?.cancel()
            task = nil
            resetClaude()
            MemoryModel.shared.refreshLensContextIfStale()
            // Start Claude Code now so its startup overlaps with the screenshot.
            claude = try? makeClaude(effort: Mode.answer.effort)
            turns = []
        }
        status = .capturing
        notice = nil
        needsPermission = false
        do {
            guard let app else { throw CaptureError.noWindow }
            let shot = try await ScreenCapture.frontWindow(of: app)
            guard generation == self.generation else { return }
            capture = shot
            imageSent = false
            status = .idle
            ask(quizMode ? .quiz : .answer)
        } catch {
            guard generation == self.generation else { return }
            if case CaptureError.noPermission = error {
                needsPermission = true
            } else {
                notice = error.localizedDescription
            }
            status = .idle
        }
    }

    /// Sends a mode request about the capture, or a typed question. A typed question works
    /// without a capture too; it's then a plain chat.
    func ask(_ mode: Mode, question: String = "") {
        guard !isBusy else { return }
        guard capture != nil || !question.isEmpty else {
            notice = "Nothing captured yet. Click into the window you want help with and press ⌥A."
            return
        }

        // A capture starts claude at Answer's low effort. A follow-up that needs more (Explain, Check, a
        // typed question) gets a new session at its own effort, sent the screenshot again with the
        // conversation so far. Going down keeps the more careful session rather than paying for a restart.
        var earlier: String?
        if claude != nil, let claudeEffort, Self.effortRank(mode.effort) > Self.effortRank(claudeEffort) {
            if imageSent { earlier = transcript() }
            resetClaude()
        }

        // The screenshot goes with the first message of each Claude Code session.
        let attachImage = capture != nil && !imageSent
        var content: [[String: Any]] = []
        if attachImage, let capture {
            content.append(["type": "image",
                            "source": ["type": "base64",
                                       "media_type": "image/jpeg",
                                       "data": capture.jpeg.base64EncodedString()]])
        }
        if let earlier, !earlier.isEmpty {
            content.append(["type": "text", "text": "<earlier_conversation>\n\(earlier)\n</earlier_conversation>"])
        }
        content.append(["type": "text",
                        "text": Prompts.userText(mode: mode, question: question,
                                                 capture: capture, isFirstTurn: attachImage)])
        send(content, display: Turn(role: .user, text: question, mode: mode), effort: mode.effort)
        // If Claude Code couldn't start, nothing was sent; the next try must attach the image again.
        if attachImage && claude != nil { imageSent = true }
    }

    private static func effortRank(_ effort: String) -> Int {
        ["low", "medium", "high", "xhigh", "max"].firstIndex(of: effort) ?? 1
    }

    /// The conversation so far as plain text, for a new session that takes over from the old one.
    private func transcript() -> String {
        turns.compactMap { turn -> String? in
            switch turn.role {
            case .user:
                let mode = (turn.mode ?? .ask).label
                return turn.text.isEmpty ? "Student (\(mode))" : "Student (\(mode)): \(turn.text)"
            case .assistant:
                return turn.text.isEmpty || turn.isError ? nil : "You: \(turn.text)"
            }
        }.joined(separator: "\n\n")
    }

    func openPrivacySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    func relaunch() {
        let path = Bundle.main.bundlePath
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Wait for this process to actually exit (up to ~10s) and only then reopen, so a quit that
        // gets cancelled (a lecture is still recording) doesn't fire `open` at the live app.
        process.arguments = ["-c", "i=0; while kill -0 \(getpid()) 2>/dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done; kill -0 \(getpid()) 2>/dev/null || open \"\(path)\""]
        try? process.run()
        Log.write("relaunch requested")
        NSApp.terminate(nil)
    }
}
