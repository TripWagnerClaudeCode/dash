import AppKit
import SwiftUI

/// `Dash --preview <out.png>` renders the overlay with sample content to a PNG and exits.
/// Lets the layout be checked without screen-recording access.
@MainActor
enum DebugPreview {
    /// Set while rendering a preview, so pages don't load live data over the sample.
    static var isRunning = false

    static func run(output: String, variant: String) {
        // A fictional user, so screenshots never show the real name or links.
        Profile.current = .sample
        if variant == "memory" {
            isRunning = true
            MemoryModel.shared.showSample()
            return console(output: output, page: .memory)
        }
        if ["today", "chat", "lens", "lecture", "portfolio", "study"].contains(variant) {
            return console(output: output, page: Console.Page(rawValue: variant)!)
        }
        if variant == "portfolio-sample-bottom" {
            PortfolioPage.isPreview = true
            PortfolioPage.previewScrollToBottom = true
            return console(output: output, page: .portfolio, sample: true)
        }
        if variant == "portfolio-sample" {
            PortfolioPage.isPreview = true
            return console(output: output, page: .portfolio, sample: true)
        }
        if variant == "portfolio-advisor" {
            PortfolioPage.isPreview = true
            return console(output: output, page: .portfolio, advisor: true)
        }
        if variant == "portfolio-bottom" {
            PortfolioPage.previewScrollToBottom = true
            return console(output: output, page: .portfolio)
        }
        let session = Session()
        let image = NSImage(size: NSSize(width: 10, height: 10))
        session.capture = Capture(jpeg: Data(), thumbnail: image, appName: "Google Chrome", windowTitle: "VHL Central")
        session.turns = [
            .init(role: .user, text: "", mode: .answer),
            .init(role: .assistant, text: """
            1. **fui** — *ayer* signals the preterite.
            2. **era** — description in the past uses the imperfect.
            3. **conocí** — first meeting, so preterite.
            """),
        ]
        if variant == "long" {
            session.turns[1].text = (1...14).map { "\($0). **respuesta** — a longer explanation line that wraps." }.joined(separator: "\n")
        } else if variant == "panel-chat" {
            session.turns += [.init(role: .user, text: "why is it fui and not iba?", mode: .ask),
                              .init(role: .assistant, text: "*Ayer* marks one completed trip, so **fui** (preterite).")]
        }
        let panel: NSPanel
        if variant == "settings" {
            // A sample hub with this Mac and a phone; never touches the Keychain or the network.
            let hub = HubClient(store: .none)
            hub.showSample(.init(url: "wss://dash-hub.example.ts.net", token: "", hub: "dash-hub", device: "MacBook Pro",
                                 app: "exp://100.64.0.1:8081"),
                           devices: [.init(id: "1", name: "MacBook Pro", role: "mac", online: true, lastSeen: Date()),
                                     .init(id: "2", name: "iPhone", role: "phone", online: false,
                                           lastSeen: Date().addingTimeInterval(-3600))],
                           state: .online)
            panel = OverlayPanel(rootView: SettingsView(hub: hub).environmentObject(session).background(.black))
            panel.setFrame(NSRect(x: -4000, y: 200, width: 380, height: 600), display: true)
        } else {
            panel = OverlayPanel(rootView: OverlayView().environmentObject(session))
            panel.setFrame(NSRect(x: -4000, y: 200, width: 440, height: 300), display: true)
        }
        panel.orderFrontRegardless()

        RunLoop.main.run(until: Date().addingTimeInterval(1.5))

        let view = panel.contentView!
        print("panel frame:", panel.frame)
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { exit(1) }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: output))
        exit(0)
    }

    /// Renders a console page with sample data (and the to-do file under DASH_SUPPORT).
    static func console(output: String, page: Console.Page, advisor: Bool = false, sample: Bool = false,
                        size: NSSize = NSSize(width: 1000, height: 700)) {
        let session = Session()
        let console = Console(lens: session, jarvis: JarvisClient())
        console.page = page
        let today = console.today
        let now = Date()
        func iso(_ hours: Double) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(hours * 3600)) }
        today.events = .loaded(TodayModel.parseEvents("""
        1. HIST2100A: Conquest and Crusade (id: a)
           \(iso(-2)) → \(iso(-1.2))
           Hall 101
        2. ECON3100A: Ensembles — boosting (id: b)
           \(iso(1)) → \(iso(2.25))
           Hall 204
        3. POLS1000A: Norms (id: c)
           \(iso(25)) → \(iso(26))
           Hall 207
        4. POLS1000A: Writing Assignment - Early Due Date (optional) (id: d)
           \(iso(38)) → \(iso(39))
           Intro International Relations.
        """))
        today.weather = .loaded("Springfield, US: overcast, 49°F (feels 45°F). Today: drizzle, high 60°F / low 49°F.")
        today.inbox = .loaded(TodayModel.parseInbox("""
        1. From: "Registrar" <registrar@example.edu> (id: x)
           Subject: Spring registration opens Monday
        2. From: Market Morning <newsletter@example.com> (id: y)
           Subject: Equities Drift Into CPI
        """))
        Usage.shared.update(from: ["status": "allowed", "unifiedWindows": [
            "five_hour": ["utilization": 0.62, "resetsAt": now.addingTimeInterval(2 * 3600 + 14 * 60).timeIntervalSince1970],
            "seven_day": ["utilization": 0.14, "resetsAt": now.addingTimeInterval(3 * 86400 + 4 * 3600).timeIntervalSince1970],
        ]], persist: false)
        today.lastRefresh = now
        isRunning = true
        today.deadlines.showSample()
        today.brief.turns = [.init(role: .user, text: ""), .init(role: .assistant, text: """
        Big Wednesday ahead, but you've got this: one more stretch and the week opens up.
        **Today**: drizzle and 49°F. ECON3100A at 3:30.
        **Week ahead**
        - POLS 1000 outline due **Fri Oct 23**. Start the thesis this weekend.
        """)]
        console.chat.turns = [
            .init(role: .user, text: "Summarize my week, then show me a quick script to count my todo items", attachments: ["syllabus.pdf"]),
            .init(role: .assistant, text: """
            ## This week

            You have **three** deadlines and one exam:

            - POLS 1000 outline — *Fri Oct 23*
            - HIST2100 Exam 1 — Mon
              - Study guide is in `~/Documents`

            | Course | Due | Weight |
            |---|---|---|
            | POLS 1000 | Fri | 10% |
            | HIST2100 | Mon | 20% |

            Here's a quick way to count the open items:

            ```bash
            grep -c '^- \\[ \\]' ~/BrightspaceToDo/todo.md
            ```
            """,
                  tools: [.init(id: "1", name: "mcp__jarvis__calendar_get", done: true),
                          .init(id: "2", name: "Bash", done: true, inputJSON: "{\"command\":\"grep -c '^- \\\\[ \\\\]' ~/BrightspaceToDo/todo.md\"}", output: "7")]),
            .init(role: .user, text: "Now email Prof. Lee that I'll be late to Friday's section"),
            .init(role: .assistant, text: "Here's the email. Approve it below to send.",
                  tools: [.init(id: "3", name: "mcp__jarvis__email_send")]),
        ]
        console.chat.status = .streaming
        console.chat.approvals = [.init(request: PermissionRequest(
            id: "r", toolName: "mcp__jarvis__email_send", displayName: "Email Send",
            input: ["to": "jordan.lee@example.edu", "subject": "Late to Friday's section",
                    "body": "Hi Professor Lee,\n\nI'll be about ten minutes late to Friday's section because of a work shift. Sorry for the disruption.\n\nBest,\nAlex"]))]
        console.lecture.courses = [Course(code: "HIST2100A", name: "Medieval Europe", hasDoc: true),
                                   Course(code: "ECON3100A", name: "Machine Learning for Economics", hasDoc: true),
                                   Course(code: "POLS1000A", name: "Intro International Relations", hasDoc: true),
                                   Course(code: "SPAN1010B", name: "Elementary Spanish", hasDoc: true),
                                   Course(code: "FILM1200A", name: "Classical Cinema", hasDoc: true)]
        if let course = console.lecture.courses.first {
            console.lecture.selected = course.code
            console.lecture.state = .recording(course, since: now.addingTimeInterval(-900))
            console.lecture.log = [.init(text: "Recording \(course.code). Notes go to its Doc every 5 minutes."),
                                   .init(text: "Filed 212 words of notes to the Doc.")]
        }
        session.capture = Capture(jpeg: Data(), thumbnail: NSImage(size: NSSize(width: 160, height: 100)),
                                  appName: "Google Chrome", windowTitle: "VHL Central — Lección 3")
        session.turns = [.init(role: .user, text: "", mode: .answer),
                         .init(role: .assistant, text: "1. **vivo**: *yo* form of -ir verb **vivir**.")]

        // The console's sidebar list and backgrounds don't survive an offscreen cacheDisplay, so
        // show the window briefly and screenshot just this window by its ID.
        // DASH_PREVIEW_SIZE=720x480 renders at another window size, to check small windows.
        var size = size
        if let spec = ProcessInfo.processInfo.environment["DASH_PREVIEW_SIZE"]?.split(separator: "x").compactMap({ Double($0) }),
           spec.count == 2 {
            size = NSSize(width: spec[0], height: spec[1])
        }
        let window = NSWindow(contentRect: NSRect(origin: CGPoint(x: 80, y: 80), size: size),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.contentView = NSHostingView(rootView: ConsoleView()
            .environmentObject(console).environmentObject(session)
            .environmentObject(console.today).environmentObject(console.lecture)
            .environmentObject(console.portfolio))
        window.orderFrontRegardless()
        if ProcessInfo.processInfo.environment["DASH_PREVIEW_SIZE"] != nil {
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            print("window frame:", window.frame.size, "content fitting:", window.contentView?.fittingSize ?? .zero)
        }
        if advisor {
            let chat = console.portfolio.advisor
            chat.turns = [
                .init(role: .user, text: "What's driving my risk?"),
                .init(role: .assistant, text: """
                **Bottom line:** one name and one theme drive most of your swings. **NVDA** is 10.4% of the portfolio but **38%** of its variance (Dash, 1-yr daily returns), and **MSFT** adds another ~21%.
                - Together that's about 59% of your risk in two correlated tech names on a quarter of the money, which is why beta is **1.21** vs. SPY.
                - Before suggesting trims: NVDA shows a gain, so trimming it is a **taxable sale**. Want me to check your tax lots and lay out options?
                """, tools: [.init(id: "1", name: "mcp__robinhood__get_equity_fundamentals", done: true),
                             .init(id: "2", name: "mcp__robinhood__get_equity_tax_lots", done: true)]),
            ]
            console.portfolio.showAdvisor = true
        }
        if sample { console.portfolio.loadPreviewSample() }
        if page == .portfolio && !sample {
            // Real data: wait for positions, prices, and the year of history.
            console.portfolio.setVisible(true)
            let deadline = Date().addingTimeInterval(60)
            while console.portfolio.lookback.isEmpty && console.portfolio.isConnected && Date() < deadline {
                RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            }
        }
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        if ProcessInfo.processInfo.environment["DASH_PREVIEW_SIZE"] != nil {
            print("final window frame:", window.frame.size, "content minimum:", window.contentMinSize)
        }
        let shot = Process()
        shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        shot.arguments = ["-x", "-o", "-l", String(window.windowNumber), output]
        try? shot.run()
        shot.waitUntilExit()
        exit(shot.terminationStatus)
    }

    /// `Dash --ask [--console] "<question>" [image.jpg] ["<follow-up>"]` runs one conversation
    /// through Claude Code and prints the streamed reply. `--console` uses the console profile
    /// (jarvis + file tools, ABOUT_ME + memory) and denies every write it's asked about.
    static func ask(_ arguments: [String]) {
        var arguments = arguments
        let console = arguments.first == "--console"
        if console { arguments.removeFirst() }
        Task {
            do {
                let session = console
                    ? try ClaudeSession(model: .sonnet, effort: "low", system: Personal.consoleSystem(),
                                        profile: .console(addDirs: [Personal.supportDir.path]))
                    : try ClaudeSession(model: .haiku, effort: "low", system: Prompts.system)
                var content: [[String: Any]] = []
                if !console, arguments.count > 1, let jpeg = FileManager.default.contents(atPath: arguments[1]) {
                    content.append(["type": "image", "source": ["type": "base64", "media_type": "image/jpeg",
                                                                "data": jpeg.base64EncodedString()]])
                }
                content.append(["type": "text", "text": arguments[0]])
                let followUps = arguments.dropFirst(console ? 1 : 2).map { [["type": "text", "text": $0]] }
                for message in [content] + followUps {
                    let result = try await session.send(content: message) { event in
                        switch event {
                        case .text(let text): print(text, terminator: "")
                        case .toolStarted(_, let name, let input): print("\n[tool] \(name) \(input)")
                        case .thinking: break
                        case .toolFinished(_, let isError, _): print("[tool done\(isError ? ", error" : "")]")
                        case .permission(let request):
                            print("\n[approval requested] \(request.toolName) \(request.input) -> denying")
                            session.respond(to: request, allow: false)
                        }
                    }
                    print("\n-- stop: \(result.stopReason ?? "none")")
                }
                session.close()
                exit(0)
            } catch {
                print("ERROR:", error.localizedDescription)
                exit(1)
            }
        }
        NSApplication.shared.run()
    }

    /// `Dash --today` loads the Today data for real, prints what was parsed, and writes the brief.
    static func today() {
        let model = TodayModel(jarvis: JarvisClient())
        model.refresh()
        Task {
            while model.isLoading { try? await Task.sleep(nanoseconds: 200_000_000) }
            if case .failed(let message) = model.events { print("calendar failed:", message) }
            for event in model.events.value ?? [] {
                print("event:", event.start.formatted(), "|", event.title, "|", event.courseCode ?? "-", event.allDay ? "(all day)" : "")
            }
            print("weather:", model.weather.value ?? "\(model.weather)")
            for mail in model.inbox.value ?? [] { print("mail:", mail.from, "|", mail.subject) }
            print("todo:", model.todos.items.map(\.text))
            model.briefMe()
            while model.brief.isBusy { try? await Task.sleep(nanoseconds: 200_000_000) }
            print("\n--- brief ---\n" + (model.brief.turns.last?.text ?? ""))
            exit(0)
        }
        NSApplication.shared.run()
    }

    /// `Dash --robinhood connect | tools | call <tool> ['{json}'] | disconnect`. Run the installed
    /// app's binary so the Keychain item belongs to the same signed app.
    static func robinhood(_ arguments: [String]) {
        Task {
            let client = RobinhoodClient()
            do {
                switch arguments.first ?? "tools" {
                case "connect":
                    try await client.connect()
                    print("Connected.")
                case "disconnect":
                    client.disconnect()
                    print("Disconnected.")
                case "call":
                    let json = arguments.count > 2 ? arguments[2] : "{}"
                    let args = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] ?? [:]
                    print(try await client.call(arguments[1], args))
                default:
                    for tool in try await client.listTools() {
                        let name = tool["name"] as? String ?? "?"
                        let schema = (tool["inputSchema"] as? [String: Any]).flatMap {
                            try? JSONSerialization.data(withJSONObject: $0["properties"] ?? [:], options: [.sortedKeys])
                        }.map { String(decoding: $0, as: UTF8.self) } ?? ""
                        print(RobinhoodClient.isReadOnly(name) ? "[read]   " : "[blocked]", name, "—",
                              (tool["description"] as? String ?? "").prefix(140).replacingOccurrences(of: "\n", with: " "),
                              "\n          args:", schema.prefix(400))
                    }
                }
                exit(0)
            } catch {
                print("ERROR:", error.localizedDescription)
                exit(1)
            }
        }
        NSApplication.shared.run()
    }

    /// `Dash --portfolio`: checks the analytics on a known series, then loads the real portfolio
    /// and prints totals and stats.
    static func portfolio() {
        // Known series: 100 → 110 → 99 → 108.9. Returns +10%, -10%, +10%; max drawdown -10%.
        let known = Series(dates: (0..<4).map { Date(timeIntervalSince1970: Double($0) * 86400) }, values: [100, 110, 99, 108.9])
        print("selftest returns:", known.returns.map { ($0 * 1000).rounded() / 10 }, "(expect 10, -10, 10)")
        print("selftest drawdown:", Analytics.drawdowns(known.values).map { ($0.max * 1000).rounded() / 10 } ?? 0, "(expect -10)")
        print("selftest beta of series vs itself:", Analytics.beta(known.returns, market: known.returns) ?? 0, "(expect 1)")
        print("selftest effective count of 4 equal weights:", Analytics.concentration([0.25, 0.25, 0.25, 0.25])?.effectiveCount ?? 0, "(expect 4)")

        let model = PortfolioModel()
        guard model.isConnected else { print("Not connected. Run Dash --robinhood connect."); exit(1) }
        model.setVisible(true)
        Task {
            let deadline = Date().addingTimeInterval(90)
            while (model.lookback.isEmpty || model.lastQuote == nil) && model.error == nil && Date() < deadline {
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
            if let error = model.error { print("ERROR:", error) }
            func money(_ v: Double) -> String { String(format: "$%.2f", v) }
            func pct(_ v: Double?) -> String { v.map { String(format: "%+.2f%%", $0 * 100) } ?? "—" }
            print("session:", model.session, "requests:", model.requestCount)
            print("total:", money(model.totalValue), "stocks:", money(model.equityValue), "cash+other:", money(model.otherValue))
            print("day:", money(model.dayChange), pct(model.dayPercent), "SPY day:", pct(model.spyDayPercent))
            print("unrealized:", money(model.unrealized), "holdings:", model.holdings.count)
            for period in model.stats.periods { print("  \(period.label): portfolio \(pct(period.portfolio)) SPY \(pct(period.spy))") }
            let s = model.stats
            print("vol:", pct(s.volatility), "spy vol:", pct(s.spyVolatility), "beta:", s.beta.map { String(format: "%.2f", $0) } ?? "—")
            print("max dd:", pct(s.maxDrawdown), "current dd:", pct(s.currentDrawdown), "top1:", pct(s.top1), "top5:", pct(s.top5),
                  "effective N:", s.effectiveCount.map { String(format: "%.1f", $0) } ?? "—")
            print("sectors:", s.sectors.prefix(4).map { "\($0.name) \(pct($0.weight))" })
            print("realized 1y:", s.realizedYear.map(money) ?? "—", "lookback points:", model.lookback.values.count, "spy points:", model.spy.values.count)
            let args = CommandLine.arguments
            if let flag = args.firstIndex(of: "advise") {
                let top = s.risk.sorted { $0.value.contribution > $1.value.contribution }.prefix(5)
                print("top risk shares:", top.map { "\($0.key) \(pct($0.value.contribution))" })
                let message = flag + 1 < args.count ? args[flag + 1] : "Give me a full review of my portfolio."
                model.askAdvisor(message)
                try? await Task.sleep(nanoseconds: 500_000_000)
                while model.advisor.isBusy {
                    for approval in model.advisor.approvals {
                        print("[approval requested] \(approval.request.toolName) -> denying")
                        model.advisor.decide(approval, allow: false)
                    }
                    try? await Task.sleep(nanoseconds: 300_000_000)
                }
                if let notice = model.advisor.notice { print("notice:", notice) }
                let answer = model.advisor.turns.last
                print("\n--- advisor (tools: \(answer?.tools.map { "\($0.name.replacingOccurrences(of: "mcp__robinhood__", with: ""))\($0.failed ? " ✗" : "")" } ?? [])) ---\n" + (answer?.text ?? ""))
            }
            model.setVisible(false)
            let before = model.requestCount
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            print("requests while hidden for 20s:", model.requestCount - before, "(expect 0)")
            exit(0)
        }
        NSApplication.shared.run()
    }

    /// `Dash --relay-check`: the advisor relay refuses strangers, lists only reads, and blocks orders.
    static func relayCheck() {
        Task {
            let relay = RobinhoodRelay(client: RobinhoodClient())
            do {
                let config = try await relay.start()
                let url = URL(string: config["url"] as! String)!
                func post(_ body: [String: Any], auth: Bool) async throws -> (Int, [String: Any]) {
                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.httpBody = try JSONSerialization.data(withJSONObject: body)
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    if auth { request.setValue("Bearer \(relay.secret)", forHTTPHeaderField: "Authorization") }
                    let (data, response) = try await URLSession.shared.data(for: request)
                    return ((response as! HTTPURLResponse).statusCode,
                            (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
                }
                let (stranger, _) = try await post(["jsonrpc": "2.0", "id": 1, "method": "tools/list"], auth: false)
                print("no secret -> HTTP \(stranger) (expect 401)")
                let (_, list) = try await post(["jsonrpc": "2.0", "id": 2, "method": "tools/list"], auth: true)
                let names = ((list["result"] as? [String: Any])?["tools"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
                print("tools offered: \(names.count); any not starting with get_ or mentioning order: \(names.filter { !$0.hasPrefix("get_") || $0.contains("order") }) (expect [])")
                let (_, call) = try await post(["jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                                "params": ["name": "place_equity_order", "arguments": ["symbol": "SPY", "quantity": "1"]]], auth: true)
                let result = call["result"] as? [String: Any]
                print("place_equity_order -> isError \(result?["isError"] as? Bool ?? false): \(((result?["content"] as? [[String: Any]])?.first?["text"] as? String) ?? "")")
                exit(0)
            } catch {
                print("ERROR:", error.localizedDescription)
                exit(1)
            }
        }
        NSApplication.shared.run()
    }

    /// `Dash --jarvis <tool> ['{"arg": 1}']` calls a jarvis tool through Dash's own client.
    static func jarvis(_ arguments: [String]) {
        Task {
            let client = JarvisClient()
            do {
                let json = arguments.count > 1 ? arguments[1] : "{}"
                let args = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] ?? [:]
                print(try await client.call(arguments[0], args))
                client.shutdown()
                exit(0)
            } catch {
                print("ERROR:", error.localizedDescription)
                client.shutdown()
                exit(1)
            }
        }
        NSApplication.shared.run()
    }

    /// `Dash --chat-selftest`: drives the real console chat against Claude Code (Haiku) to check
    /// context across a resume, stop-without-amnesia, queueing and approval cards. It saves its
    /// own throwaway chat and deletes it at the end.
    static func chatSelfTest() {
        setvbuf(stdout, nil, _IONBF, 0)
        Task { @MainActor in
            let chat = ChatConversation()
            var failures = 0
            @MainActor func check(_ name: String, _ ok: Bool, _ detail: String = "") {
                print("\(ok ? "PASS" : "FAIL"): \(name) \(detail)")
                if !ok {
                    failures += 1
                    let turn = chat.turns.last
                    print("   state: status=\(chat.status) notice=\(chat.notice ?? "-") approvals=\(chat.approvals.map { "\($0.request.toolName) \($0.request.input)" }) "
                          + "tools=\(turn?.tools.map { "\($0.name)\($0.done ? "✓" : "…")" } ?? []) text=\(turn?.text.prefix(120) ?? "")")
                }
            }
            @MainActor func idle(timeout: Double = 60) async {
                let end = Date().addingTimeInterval(timeout)
                while chat.isBusy && Date() < end { try? await Task.sleep(nanoseconds: 100_000_000) }
            }
            @MainActor func waitFor(_ timeout: Double, _ condition: @MainActor () -> Bool) async {
                let end = Date().addingTimeInterval(timeout)
                while !condition() && Date() < end { try? await Task.sleep(nanoseconds: 100_000_000) }
            }
            @MainActor func lastText() -> String { chat.turns.last?.text ?? "" }

            chat.newChat()
            chat.setModel("claude-haiku-4-5")
            chat.setEffort("low")
            let testID = chat.meta.id

            chat.ask("For this conversation only, the codeword is PINEAPPLE. Don't save it anywhere. Reply with just OK.")
            await idle()
            check("first answer arrives", !lastText().isEmpty && chat.turns.last?.isError == false, lastText())
            check("session marked started", chat.meta.sessionStarted)

            chat.ask("Write a 600 word essay about the history of tea.")
            await waitFor(30) { chat.turns.last?.text.count ?? 0 > 40 }
            chat.stop()
            await idle(timeout: 20)
            check("stop keeps partial text and marks stopped", chat.turns.last?.stopped == true && !lastText().isEmpty,
                  "(\(lastText().count) chars)")
            check("stop didn't kill the session", chat.claude != nil)

            chat.ask("What was the codeword? Answer with one word.")
            await idle()
            check("context survives a stop", lastText().uppercased().contains("PINEAPPLE"), lastText())

            chat.setEffort("medium") // respawns the session with --resume
            check("setting change drops the live process", chat.claude == nil)
            chat.ask("Once more: what was the codeword? One word.")
            await idle()
            check("context survives a respawn (--resume)", lastText().uppercased().contains("PINEAPPLE"), lastText())

            // Queueing: the second message is sent automatically once the first answer is in.
            chat.ask("Reply with just the word ONE.")
            chat.ask("Reply with just the word TWO.")
            check("second message is queued while busy", chat.queue.count == 1)
            await idle()
            await waitFor(60) { chat.queue.isEmpty && !chat.isBusy }
            let texts = chat.turns.filter { $0.role == .assistant }.suffix(2).map(\.text)
            check("queued message ran after the first", texts.count == 2 && texts[0].contains("ONE") && texts[1].contains("TWO"),
                  "\(texts)")

            // A state-changing shell command must come back as an approval card, and Deny must stop it.
            let marker = "/private/tmp/dash_selftest_marker"
            try? FileManager.default.removeItem(atPath: marker)
            chat.ask("Use the Bash tool to run exactly: touch \(marker)   Then say done.")
            await waitFor(60) { !chat.approvals.isEmpty || !chat.isBusy }
            check("Bash change raises an approval card", chat.approvals.first?.request.toolName == "Bash",
                  chat.approvals.first.map { "\($0.request.input)" } ?? "none")
            check("approval offers an always-allow rule", chat.approvals.first?.request.suggestions.isEmpty == false)
            if let approval = chat.approvals.first { chat.decide(approval, allow: false) }
            await idle()
            check("denied command did not run", !FileManager.default.fileExists(atPath: marker))

            // Persistence: the chat reloads from disk with its turns.
            let reloaded = ChatConversation()
            check("chat is saved to disk", reloaded.chats.contains { $0.id == testID })
            reloaded.select(testID)
            check("saved chat reloads with its turns", reloaded.turns.count == chat.turns.count,
                  "\(reloaded.turns.count) vs \(chat.turns.count)")

            // Old or minimal chat files still load, and a missing index is rebuilt from the files.
            let legacyID = UUID()
            let dir = Personal.supportDir.appendingPathComponent("chats", isDirectory: true)
            let legacyFile = dir.appendingPathComponent("\(legacyID.uuidString).json")
            let legacy = "{\"meta\":{\"id\":\"\(legacyID.uuidString)\"},\"turns\":[{\"role\":\"user\",\"text\":\"hi\"}]}"
            try? legacy.write(to: legacyFile, atomically: true, encoding: .utf8)
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("index.json"))
            let rebuilt = ChatConversation()
            check("missing index is rebuilt from chat files", rebuilt.chats.contains { $0.id == legacyID })
            rebuilt.select(legacyID)
            check("a chat file with missing fields still loads", rebuilt.turns.count == 1 && rebuilt.turns[0].text == "hi")
            rebuilt.delete(legacyID)
            check("deleting removes the file", !FileManager.default.fileExists(atPath: legacyFile.path))

            chat.delete(testID)
            chat.close()
            print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
            exit(failures == 0 ? 0 : 1)
        }
        NSApplication.shared.run()
    }
}
