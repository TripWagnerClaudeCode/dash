import AppKit

// Writing to a Claude Code process that has exited should fail with EPIPE, not kill Dash.
signal(SIGPIPE, SIG_IGN)

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let args = CommandLine.arguments
    if let flag = args.firstIndex(of: "--preview"), flag + 1 < args.count {
        app.setActivationPolicy(.accessory)
        DebugPreview.run(output: args[flag + 1], variant: flag + 2 < args.count ? args[flag + 2] : "")
    }
    if let flag = args.firstIndex(of: "--ask"), flag + 1 < args.count {
        app.setActivationPolicy(.accessory)
        DebugPreview.ask(Array(args[(flag + 1)...]))
    }
    if let flag = args.firstIndex(of: "--jarvis"), flag + 1 < args.count {
        app.setActivationPolicy(.accessory)
        DebugPreview.jarvis(Array(args[(flag + 1)...]))
    }
    if let flag = args.firstIndex(of: "--robinhood") {
        app.setActivationPolicy(.accessory)
        DebugPreview.robinhood(Array(args[(flag + 1)...]))
    }
    if args.contains("--relay-check") {
        app.setActivationPolicy(.accessory)
        DebugPreview.relayCheck()
    }
    if args.contains("--portfolio") {
        app.setActivationPolicy(.accessory)
        DebugPreview.portfolio()
    }
    if args.contains("--chat-selftest") {
        app.setActivationPolicy(.accessory)
        DebugPreview.chatSelfTest()
    }
    if let flag = args.firstIndex(of: "--login-item") {
        app.setActivationPolicy(.accessory)
        DebugPreview.loginItem(Array(args[(flag + 1)...]))
    }
    if let flag = args.firstIndex(of: "--hub-pair") {
        app.setActivationPolicy(.accessory)
        DebugPreview.hubPair(Array(args[(flag + 1)...]))
    }
    if let flag = args.firstIndex(of: "--hub-import") {
        app.setActivationPolicy(.accessory)
        DebugPreview.hubImport(Array(args[(flag + 1)...]))
    }
    if args.contains("--hub-chat-check") {
        app.setActivationPolicy(.accessory)
        DebugPreview.hubChatCheck()
    }
    if let flag = args.firstIndex(of: "--hub-memory-check") {
        app.setActivationPolicy(.accessory)
        DebugPreview.hubMemoryCheck(Array(args[(flag + 1)...]))
    }
    if args.contains("--hub-check") {
        app.setActivationPolicy(.accessory)
        DebugPreview.hubCheck()
    }
    if args.contains("--today") {
        app.setActivationPolicy(.accessory)
        DebugPreview.today()
    }
    let delegate = AppDelegate()
    app.delegate = delegate
    // A regular app, so Dash has a Dock icon and shows up in Cmd-Tab; clicking the icon reopens the console.
    app.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { app.run() }
}
