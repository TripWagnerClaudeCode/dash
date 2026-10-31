import AppKit
import Carbon
import Combine
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let jarvis = JarvisClient()
    private lazy var console = Console(jarvis: jarvis)
    private lazy var consoleWindow = ConsoleWindowController(console: console)
    /// The Dash hub on the always-on PC, which now serves the phone (and its app) and holds the shared
    /// to-do list and Today. This Mac's own old hub and Metro server are no longer started.
    private let hub = HubClient()
    private lazy var settings = SettingsWindowController(hub: hub)
    private var lectureRemote: LectureRemote?
    private var statusItem: NSStatusItem!
    private var consoleHotKey: HotKey?
    private var recordingWatch: AnyCancellable?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Per-session MCP configs from a previous run (their relay secrets are already dead).
        let support = Personal.supportDir
        for name in (try? FileManager.default.contentsOfDirectory(atPath: support.path)) ?? []
        where name.hasPrefix("mcp-") && name.hasSuffix(".json") {
            try? FileManager.default.removeItem(at: support.appendingPathComponent(name))
        }
        Log.trimIfLarge()
        Log.write("launch")
        setUpStatusItem()
        setUpMainMenu()
        // ⌥L opens or hides the console.
        consoleHotKey = HotKey(id: 3, keyCode: kVK_ANSI_L, modifiers: optionKey) { [weak self] in
            self?.consoleWindow.toggle()
        }
        // The menu bar icon turns into a red record dot while a lecture is recording.
        recordingWatch = console.lecture.$state.sink { [weak self] state in
            let recording = state != .idle
            self?.statusItem.button?.image = NSImage(systemSymbolName: recording ? "record.circle.fill" : Self.menuBarSymbol,
                                                     accessibilityDescription: "Dash")
            self?.statusItem.button?.contentTintColor = recording ? .systemRed : nil
        }

        console.today.useHub(hub)
        console.chat.useHub(hub)
        console.portfolio.useHub(hub)
        MemoryModel.shared.useHub(hub)
        lectureRemote = LectureRemote(hub: hub, lecture: console.lecture)
        // Usage is per subscription, so the hub and this Mac share whichever reading is newest.
        hub.on("usage") { Usage.shared.applyHub($0) }
        Usage.shared.forward = { [weak self] info in
            guard let hub = self?.hub, hub.isOnline else { return }
            Task { _ = try? await hub.request("usage.report", ["info": info]) }
        }
        hub.connect()

        // After useHub, which can replace the chat (and its notice) with the hub's open one. The console
        // opens on Chat so the notice is seen. Nothing is shown here otherwise: opening Dash from the Dock
        // or Finder activates it and applicationDidBecomeActive brings up the console, while a login-item
        // launch stays in the background.
        if consoleHotKey?.registrationError != nil {
            console.chat.notice = "⌥L is already used by another app, so Dash can't listen for it. Use the menu bar icon or the Dock instead."
        }
        if ClaudeSession.executable == nil { console.chat.notice = ClaudeCLIError.notInstalled.errorDescription }
        if console.chat.notice != nil { consoleWindow.show(page: .chat) }
    }

    /// Clicking Dash's Dock icon (or opening it again from Spotlight, Launchpad or Finder) while
    /// it's running brings the console back. Quit is ⌘Q or the menu bar item.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        consoleWindow.show()
        return false
    }

    /// Tabbing back to Dash with nothing on screen would otherwise show only a menu bar.
    func applicationDidBecomeActive(_ notification: Notification) {
        // Wait a beat: activating from a menu item or an alert shows its own window right after, and
        // that shouldn't also bring up the console.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self, NSApp.isActive, NSApp.modalWindow == nil, NSApp.keyWindow == nil,
                  !consoleWindow.hasVisibleWindow, !settings.isVisible else { return }
            consoleWindow.show()
        }
    }

    /// Quitting mid-lecture would end the recording without filing its notes, so ask first.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard console.lecture.isActive else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "A lecture is still recording."
        alert.informativeText = "Quitting stops the recording without filing the last notes or cleaning up today's Doc. Stop it from the Lecture page first to finish properly."
        alert.addButton(withTitle: "Keep Recording")
        alert.addButton(withTitle: "Quit Anyway")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            consoleWindow.show(page: .lecture)
            return .terminateCancel
        }
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        Log.write("terminate")
        ClaudeSession.closeAll()
        jarvis.shutdown(wait: true)
    }

    private func showSettings() {
        settings.show()
    }

    // MARK: Menu bar

    private static let menuBarSymbol = "rectangle.grid.1x2"

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: Self.menuBarSymbol, accessibilityDescription: "Dash")

        let menu = NSMenu()
        menu.addItem(withTitle: "Open Console  ⌥L", action: #selector(menuConsole), keyEquivalent: "")
        menu.addItem(withTitle: "Lecture Notes…", action: #selector(menuLecture), keyEquivalent: "")
        menu.addItem(withTitle: "Settings…", action: #selector(menuSettings), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Dash", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for item in menu.items where item.action != #selector(NSApplication.terminate(_:)) {
            item.target = self
        }
        statusItem.menu = menu
    }

    /// Dash is a regular app, so give it a small menu bar: ⌘, ⌘L ⌘Q, editing, and ⌘W.
    private func setUpMainMenu() {
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Settings…", action: #selector(menuSettings), keyEquivalent: ",").target = self
        appMenu.addItem(withTitle: "Open Console", action: #selector(menuConsole), keyEquivalent: "l").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Dash", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        // The console is a normal window, so it needs the standard editing shortcuts.
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem()
        editItem.submenu = editMenu
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        let windowItem = NSMenuItem()
        windowItem.submenu = windowMenu
        let mainMenu = NSMenu()
        mainMenu.addItem(appItem)
        mainMenu.addItem(editItem)
        mainMenu.addItem(windowItem)
        NSApp.mainMenu = mainMenu
    }

    @objc private func menuConsole() { consoleWindow.show() }
    @objc private func menuLecture() { consoleWindow.show(page: .lecture) }

    @objc private func menuSettings() { showSettings() }
}
