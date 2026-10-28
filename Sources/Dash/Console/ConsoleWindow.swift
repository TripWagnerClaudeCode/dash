import AppKit
import SwiftUI

/// Everything the console shows, shared by its pages.
@MainActor
final class Console: ObservableObject {
    enum Page: String, CaseIterable, Identifiable {
        case today, chat, lens, lecture, portfolio, study, memory
        var id: String { rawValue }

        var title: String {
            switch self {
            case .today: "Today"
            case .chat: "Chat"
            case .lens: "Lens"
            case .lecture: "Lecture"
            case .portfolio: "Portfolio"
            case .study: "Study"
            case .memory: "Memory"
            }
        }

        var icon: String {
            switch self {
            case .today: "sun.horizon"
            case .chat: "bubble.left.and.bubble.right"
            case .lens: "text.viewfinder"
            case .lecture: "waveform"
            case .portfolio: "chart.line.uptrend.xyaxis"
            case .study: "graduationcap"
            case .memory: "brain"
            }
        }
    }

    @Published var page: Page? = .today
    @Published var chatDraft = ""

    let chat = ChatConversation()
    let lens: Session
    let today: TodayModel
    let lecture: LectureController
    let portfolio = PortfolioModel()

    init(lens: Session, jarvis: JarvisClient) {
        self.lens = lens
        today = TodayModel(jarvis: jarvis)
        lecture = LectureController(jarvis: jarvis)
        // Unless something new has been typed since.
        chat.returnUnsent = { [weak self] text in
            if self?.chatDraft.isEmpty == true { self?.chatDraft = text }
        }
    }

    /// Opens Chat with a question sent right away, or just typed in the field.
    func chat(_ text: String, send: Bool) {
        page = .chat
        if send {
            chat.ask(text)
        } else {
            chatDraft = text
        }
    }

    func launch(_ button: ToolButton) {
        switch button.action {
        case .skill(let name, let starter):
            guard !chat.isBusy else {
                chat.notice = "Wait for the current answer to finish (or stop it) before starting a skill."
                page = .chat
                return
            }
            chat.newChat(skill: Skill.load(name))
            chat(starter, send: false)
        case .url(let url): Toolbox.open(url)
        case .urls(let urls): urls.forEach(Toolbox.open)
        case .file(let path): Toolbox.openFile(path)
        }
    }
}

/// The console: a normal window with a sidebar of pages.
@MainActor
final class ConsoleWindowController {
    private var window: NSWindow?
    private let console: Console

    init(console: Console) {
        self.console = console
    }

    /// On screen and not minimized. A minimized window reports `isVisible == false` on its own.
    var hasVisibleWindow: Bool { window?.isVisible == true }

    /// Frontmost enough that ⌥L should hide it rather than raise it.
    var isVisible: Bool { window?.isVisible == true && NSApp.isActive }

    func show(page: Console.Page? = nil) {
        if let page { console.page = page }
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 680),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                  backing: .buffered, defer: false)
            window.title = "Dash"
            window.titlebarAppearsTransparent = true
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 720, height: 480)
            window.collectionBehavior.insert(.moveToActiveSpace)
            window.contentView = NSHostingView(rootView: ConsoleView()
                .environmentObject(console)
                .environmentObject(console.lens)
                .environmentObject(console.today)
                .environmentObject(console.lecture)
                .environmentObject(console.portfolio))
            // Portfolio prices only poll while the console is actually on screen.
            for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.willCloseNotification] {
                NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] note in
                    MainActor.assumeIsolated {
                        let closing = note.name == NSWindow.willCloseNotification
                        self?.console.portfolio.setVisible(!closing && window.occlusionState.contains(.visible))
                    }
                }
            }
            window.setFrameAutosaveName("DashConsoleFrame")
            if window.setFrameUsingName("DashConsoleFrame") {
                Self.clampToScreen(window)
            } else {
                window.center()
            }
            self.window = window
        }
        guard let window else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        // Activation is cooperative on recent macOS, so a hotkey press may not bring the app forward.
        window.orderFrontRegardless()
    }

    func toggle() {
        if isVisible { window?.orderOut(nil) } else { show() }
    }

    /// A saved frame can outlive the display it was made on (an external monitor, a different
    /// scaling mode), leaving the window partly off-screen. Shrink and move it back onto the screen.
    private static func clampToScreen(_ window: NSWindow) {
        let screen = NSScreen.screens.first { $0.frame.intersects(window.frame) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        var frame = window.frame
        frame.size.width = min(max(frame.width, window.minSize.width), visible.width)
        frame.size.height = min(max(frame.height, window.minSize.height), visible.height)
        frame.origin.x = min(max(frame.minX, visible.minX), visible.maxX - frame.width)
        frame.origin.y = min(max(frame.minY, visible.minY), visible.maxY - frame.height)
        if frame != window.frame { window.setFrame(frame, display: false) }
    }
}

/// Beside "Chat" in the sidebar: an orange dot when Claude is waiting on an approval, a spinner
/// while it's answering. Without it a pending card on another page leaves Claude waiting unseen.
private struct ChatSidebarBadge: View {
    @ObservedObject var chat: ChatConversation

    var body: some View {
        if chat.needsAttention {
            Circle().fill(.orange).frame(width: 7, height: 7).help("Waiting for your approval")
        } else if chat.isBusy {
            ProgressView().controlSize(.mini).scaleEffect(0.7)
        }
    }
}

struct ConsoleView: View {
    @EnvironmentObject var console: Console
    @EnvironmentObject var lecture: LectureController
    @EnvironmentObject var portfolio: PortfolioModel

    var body: some View {
        NavigationSplitView {
            List(Console.Page.allCases, selection: $console.page) { page in
                HStack {
                    Label(page.title, systemImage: page.icon)
                    Spacer()
                    if page == .chat { ChatSidebarBadge(chat: console.chat) }
                    if page == .lecture && lecture.isActive {
                        Circle().fill(.red).frame(width: 7, height: 7).help("Recording")
                    }
                    if page == .portfolio, portfolio.isConnected, !portfolio.holdings.isEmpty {
                        Text(Format.percent(portfolio.dayPercent))
                            .font(.system(size: 11, weight: .medium).monospacedDigit())
                            .foregroundStyle(Format.tint(portfolio.dayPercent))
                            .help("Portfolio today")
                    }
                }
                .tag(page)
            }
            .safeAreaInset(edge: .bottom) { UsageSidebarFooter() }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180, max: 230)
        } detail: {
            switch console.page ?? .today {
            case .today: TodayView()
            case .chat: ChatPage()
            case .lens: LensPage()
            case .lecture: LecturePage()
            case .portfolio: PortfolioPage()
            case .study: StudyPage()
            case .memory: MemoryPage()
            }
        }
    }
}
