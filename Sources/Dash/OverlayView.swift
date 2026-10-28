import AppKit
import SwiftUI

/// The floating panel: a header you drag by (with every action as a button), the
/// conversation, and a chat field for follow-up questions.
struct OverlayView: View {
    @EnvironmentObject var session: Session

    var body: some View {
        VStack(spacing: 0) {
            Header()
            Divider().opacity(0.5)
            answerArea
            Divider().opacity(0.5)
            ChatBar()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(GlassBackground())
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.white.opacity(0.1)))
        .overlay(alignment: .bottomTrailing) {
            ResizeGrip().frame(width: 12, height: 12).help("Drag to resize")
        }
        .environment(\.colorScheme, .dark)
    }

    private var answerArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if session.needsPermission {
                        PermissionNotice()
                    } else if let notice = session.notice {
                        Text(notice).font(.system(size: 12)).foregroundStyle(.secondary)
                    } else if session.status == .capturing && session.turns.isEmpty {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text("Capturing…").font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    } else if session.turns.isEmpty {
                        Text("Click into your homework window and press ⌥A (or the camera button) to answer what's on screen. Type below to chat.")
                            .font(.system(size: 12))
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(session.turns) { turn in
                        TurnView(turn: turn, isLive: session.isBusy && turn.id == session.turns.last?.id)
                            .equatable()
                    }
                    Color.clear.frame(height: 0).id("bottom")
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: session.turns.last?.text) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: session.turns.count) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }
}

private struct Header: View {
    @EnvironmentObject var session: Session

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "text.viewfinder").foregroundStyle(.secondary)
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .allowsHitTesting(false)
            Spacer(minLength: 6)

            QuizControl()
            IconButton("camera.viewfinder", help: "Capture window and answer (⌥A)") { session.recapture() }
            if session.quizMode {
                IconButton("plus.viewfinder", help: "Add another screen to this quiz (⌥⇧A)") { session.recaptureAppending() }
            }
            Menu {
                ForEach([Mode.answer, .hint, .explain, .check]) { mode in
                    Button { session.ask(mode) } label: { Label(mode.label, systemImage: mode.icon) }
                }
            } label: {
                Image(systemName: "wand.and.stars")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .frame(width: 26, height: 22)
            .help("Answer, Hint, Explain, or Check My Work on the current capture")
            .disabled(session.isBusy || session.capture == nil)

            IconButton("doc.on.doc", help: "Copy last answer") { session.copyLastAnswer() }
            IconButton("trash", help: "Clear conversation") { session.clear() }
                .disabled(session.isBusy)
            IconButton("gearshape", help: "Settings") { session.openSettings() }
            IconButton("macwindow", help: "Open the Dash console (⌥L)") { session.openConsole() }
            IconButton("xmark", help: "Hide (⌥Space)") { session.hide() }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(height: 32)
        .background(WindowDragArea())
        .contextMenu {
            Button("Snap Over Dock") { session.snapOverDock() }
            Button("Reset Position") { session.resetPosition() }
            Button("Quit Dash") { NSApp.terminate(nil) }
        }
    }

    private var title: String {
        (session.quizMode ? "Quiz · " : "") + (session.capture.map { $0.appName } ?? "Dash")
    }
}

/// Quiz mode on/off with an optional countdown. Shows the time left once a timer is running.
private struct QuizControl: View {
    @EnvironmentObject var session: Session

    var body: some View {
        Menu {
            if session.quizMode {
                Button("Turn Quiz Mode Off") { session.setQuizMode(false) }
            } else {
                Text("Only for quizzes that allow AI help")
                Divider()
                Button("Quiz Mode, No Timer") { session.setQuizMode(true) }
                ForEach([10, 15, 20, 30, 45], id: \.self) { minutes in
                    Button("Quiz Mode, \(minutes) min") { session.setQuizMode(true, minutes: minutes) }
                }
            }
        } label: {
            if let deadline = session.quizDeadline {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let left = max(0, Int(deadline.timeIntervalSince(context.date)))
                    Text(String(format: "%d:%02d", left / 60, left % 60))
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundStyle(left < 120 ? Color.red : Color.orange)
                }
            } else {
                Image(systemName: "timer").foregroundStyle(session.quizMode ? Color.orange : Color.secondary)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(minWidth: 26, minHeight: 22)
        .help("Quiz mode: terse answers for every question, faster model, optional timer")
        .disabled(session.isBusy)
    }
}

private struct IconButton: View {
    let symbol: String
    let help: String
    let action: () -> Void

    init(_ symbol: String, help: String, action: @escaping () -> Void) {
        self.symbol = symbol
        self.help = help
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12))
                .frame(width: 26, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .help(help)
    }
}

private struct ChatBar: View {
    @EnvironmentObject var session: Session
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            TextField(session.capture == nil ? "Ask Claude anything…" : "Ask about this screen…",
                      text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .lineLimit(1...4)
                .focused($focused)
                .onSubmit(send)
            if session.isBusy {
                IconButton("stop.circle.fill", help: "Stop") { session.stop() }
            } else {
                IconButton("arrow.up.circle.fill", help: "Send (Return)", action: send)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 14)
        .padding(.vertical, 7)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !session.isBusy else { return }
        session.ask(.ask, question: text)
        draft = ""
    }
}

/// Equatable so SwiftUI skips re-parsing the markdown of finished turns on every streamed token.
struct TurnView: View, Equatable {
    let turn: Conversation.Turn
    let isLive: Bool
    var fontSize: CGFloat = 12.5

    var body: some View {
        switch turn.role {
        case .user:
            if !turn.text.isEmpty {
                Text(turn.text)
                    .font(.system(size: fontSize - 0.5))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            } else if let mode = turn.mode, mode != .answer {
                // Answer is the default action, so only label the other modes.
                Text(mode.label)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
        case .assistant:
            // One leading-aligned stack, so tool chips sit flush left above the text.
            VStack(alignment: .leading, spacing: 8) {
                if !turn.tools.isEmpty { ToolChips(tools: turn.tools) }
                if turn.text.isEmpty && isLive {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text(turn.tools.contains { !$0.done } ? "Working…" : "Thinking…")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                } else if !turn.text.isEmpty || !isLive {
                    Text(Self.render(turn.text))
                        .font(.system(size: fontSize))
                        .lineSpacing(1.5)
                        .foregroundStyle(turn.isError ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    static func render(_ text: String) -> AttributedString {
        // Only inline markdown renders here, so show "## Heading" lines as bold text.
        let text = text.components(separatedBy: "\n").map { line in
            guard let range = line.range(of: #"^#{1,6} +"#, options: .regularExpression) else { return line }
            return "**\(line[range.upperBound...])**"
        }.joined(separator: "\n")
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

struct PermissionNotice: View {
    @EnvironmentObject var session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Dash needs Screen Recording permission.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            HStack {
                Button("Open Settings") { session.openPrivacySettings() }
                Button("Relaunch") { session.relaunch() }
            }
        }
        .controlSize(.small)
    }
}

private struct GlassBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
