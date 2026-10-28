import AppKit
import SwiftUI

/// Settings live in their own normal window so the controls always have room.
@MainActor
final class SettingsWindowController {
    private var window: NSWindow?
    private let session: Session
    private let hub: HubClient

    init(session: Session, hub: HubClient) {
        self.session = session
        self.hub = hub
    }

    var isVisible: Bool { window?.isVisible == true }

    func show() {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 290),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Dash Settings"
            window.isReleasedWhenClosed = false
            window.level = .floating
            window.contentView = NSHostingView(rootView: SettingsView(hub: hub) { [weak window] in window?.close() }
                .environmentObject(session))
            window.center()
            self.window = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

struct SettingsView: View {
    @EnvironmentObject var session: Session
    @AppStorage(Prefs.modelID) private var modelID = ClaudeModel.defaultID
    @AppStorage(Prefs.quizModelID) private var quizModelID = ClaudeModel.sonnet.id
    @AppStorage(Prefs.opacity) private var opacity = Prefs.defaultOpacity
    var hub: HubClient?
    var close: () -> Void = {}

    var body: some View {
        Form {
            Section {
                LabeledContent("Account") {
                    Text(ClaudeSession.executable == nil ? "Claude Code not found" : "Your Claude subscription")
                        .foregroundStyle(ClaudeSession.executable == nil ? .red : .secondary)
                }

                Picker("Model", selection: $modelID) {
                    ForEach(ClaudeModel.all) { Text("\($0.name) · \($0.blurb)").tag($0.id) }
                }

                Picker("Quiz model", selection: $quizModelID) {
                    ForEach(ClaudeModel.all) { Text("\($0.name) · \($0.blurb)").tag($0.id) }
                }

                LabeledContent("Opacity") {
                    HStack {
                        Slider(value: $opacity, in: 0.3...1)
                            .onChange(of: opacity) { session.setOpacity(opacity) }
                        Text("\(Int(opacity * 100))%")
                            .monospacedDigit()
                            .frame(width: 36, alignment: .trailing)
                    }
                }
            }

            if let hub { HubSettingsSection(hub: hub) }

            Section {
                Text("Dash runs through Claude Code, so it uses your subscription's limits, not an API key. The model applies to the panel and console chats from the next conversation; the daily brief and lecture notes use Sonnet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("⌥A capture + answer · ⌥⇧A add a screen (quiz mode) · ⌥Space show/hide panel · ⌥L console · drag the panel by its top bar · resize from the bottom-right corner")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Snap Over Dock") { session.snapOverDock() }
                    Button("Reset Position") { session.resetPosition() }
                    Spacer()
                    Button("Done", action: close).keyboardShortcut(.defaultAction)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 380)
        .fixedSize(horizontal: false, vertical: true)
    }
}
