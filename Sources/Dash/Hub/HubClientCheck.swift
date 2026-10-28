import AppKit
import Foundation
import ServiceManagement

extension DebugPreview {
    /// `Dash --hub-pair <address> <code>`: pairs this Mac with the Dash hub from the command line. With
    /// DASH_HUB_CREDENTIALS=/path/file.json the sign-in goes to that file instead of the Keychain.
    static func hubPair(_ arguments: [String]) {
        guard arguments.count >= 2 else {
            print("Usage: Dash --hub-pair wss://dash-hub.….ts.net 123456")
            exit(2)
        }
        let hub = HubClient()
        Task { @MainActor in
            do {
                try await hub.pair(url: arguments[0], code: arguments[1])
                print("Paired with \(hub.credentials?.hub ?? "?") as \(hub.credentials?.device ?? "?")")
                exit(0)
            } catch {
                print("Pairing failed:", error.localizedDescription)
                exit(1)
            }
        }
        NSApplication.shared.run()
    }

    /// `Dash --hub-import <file>`: moves a pairing made with DASH_HUB_CREDENTIALS=<file> into the Keychain
    /// (run with the installed app's binary) and deletes the file, so testing and the app share one device.
    static func hubImport(_ arguments: [String]) {
        guard let path = arguments.first, let credentials = CredentialStore.file(URL(fileURLWithPath: path)).load() else {
            print("Usage: Dash --hub-import /path/to/credentials.json (a pairing saved by --hub-pair)")
            exit(2)
        }
        do {
            try CredentialStore.standard.save(credentials)
        } catch {
            print(error.localizedDescription)
            exit(1)
        }
        guard CredentialStore.standard.load() == credentials else {
            print("Couldn't save the pairing to the Keychain.")
            exit(1)
        }
        CredentialStore.file(URL(fileURLWithPath: path)).delete()
        print("Imported the pairing with \(credentials.hub) (as \(credentials.device)) into the Keychain.")
        exit(0)
    }

    /// `Dash --hub-chat-check`: drives the console's ChatConversation through the hub on Haiku: a reply,
    /// Deny and Approve on a real command, Stop, switching chats, rename and delete. Meant for a throwaway
    /// hub (DASH_HUB_CREDENTIALS + DASH_HUB_CACHE); the chats it makes are deleted at the end.
    static func hubChatCheck() {
        let hub = HubClient()
        let chat = ChatConversation()
        chat.useHub(hub)
        Task { @MainActor in
            var failures = 0
            func check(_ ok: Bool, _ label: String) {
                print(ok ? "PASS" : "FAIL", label)
                if !ok { failures += 1 }
            }
            func wait(_ seconds: Double, until condition: () -> Bool) async -> Bool {
                let deadline = Date().addingTimeInterval(seconds)
                while !condition() && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
                return condition()
            }
            guard hub.isPaired else { print("Not paired. Use --hub-pair with DASH_HUB_CREDENTIALS first."); exit(1) }
            hub.connect()
            check(await wait(20) { hub.isOnline }, "signs in")
            let last = { chat.turns.last?.text ?? "" }
            let done = { !chat.isBusy && chat.turns.last?.role == .assistant && !(chat.turns.last?.text.isEmpty ?? true) }

            chat.newChat()
            chat.setModel(ClaudeModel.haiku.id)
            let first = chat.meta.id
            check(chat.ask("Reply with exactly the word: pong"), "sends a message")
            check(await wait(90) { done() && chat.turns.count == 2 } && last().localizedCaseInsensitiveContains("pong"),
                  "streams the reply into the chat (\(last().prefix(40)))")
            check(await wait(5) { chat.chats.contains { $0.id == first } }, "the chat shows up in the history")

            let marker = FileManager.default.temporaryDirectory.appendingPathComponent("dash-hub-chat-\(UUID().uuidString.prefix(6))").path
            _ = chat.ask("Use the Bash tool to run exactly this command and nothing else: mkdir \(marker)")
            check(await wait(90) { !chat.approvals.isEmpty }, "shows an Approve/Deny card from the hub")
            if let card = chat.approvals.first {
                check(card.request.toolName == "Bash" && "\(card.request.input["command"] ?? "")".contains(marker), "the card shows the command")
                chat.decide(card, allow: false)
            }
            _ = await wait(90) { !chat.isBusy }
            check(!FileManager.default.fileExists(atPath: marker), "Deny keeps it from running")
            _ = chat.ask("Now please run it: mkdir \(marker)")
            check(await wait(90) { !chat.approvals.isEmpty }, "asks again")
            if let card = chat.approvals.first { chat.decide(card, allow: true) }
            check(await wait(90) { !chat.isBusy && FileManager.default.fileExists(atPath: marker) }, "Approve runs it")
            try? FileManager.default.removeItem(atPath: marker)

            let before = chat.turns.count
            _ = chat.ask("Count from 1 to 400, one number per line, no other text.")
            // Wait for the new answer to be streaming before pressing Stop.
            _ = await wait(60) { chat.turns.count == before + 2 && chat.isBusy && last().count > 20 }
            chat.stop()
            let stopped = await wait(30) { !chat.isBusy && chat.turns.last?.stopped == true }
            check(stopped && chat.turns.last?.stopped == true,
                  "Stop ends the answer (busy \(chat.isBusy), stopped \(chat.turns.last?.stopped == true), turns \(chat.turns.count), last \(last().prefix(30).replacingOccurrences(of: "\n", with: " ")))")

            let count = chat.turns.count
            chat.newChat()
            check(chat.turns.isEmpty, "New chat starts empty")
            chat.select(first)
            check(await wait(15) { chat.meta.id == first && chat.turns.count == count },
                  "switches back to the earlier chat (same id \(chat.meta.id == first), turns \(chat.turns.count) of \(count), notice \(chat.notice ?? "-"))")
            chat.rename(first, to: "Hub chat check")
            check(await wait(10) { chat.chats.first { $0.id == first }?.title == "Hub chat check" }, "renames")
            chat.delete(first)
            check(await wait(10) { !chat.chats.contains { $0.id == first } }, "deletes")
            print(failures == 0 ? "\nAll hub chat checks passed." : "\n\(failures) check(s) failed.")
            exit(failures == 0 ? 0 : 1)
        }
        NSApplication.shared.run()
    }

    /// `Dash --hub-check`: signs in with the saved pairing and drives Today and the to-do list through the
    /// hub the way the app does. It adds one clearly labeled to-do and removes it again.
    static func hubCheck() {
        let hub = HubClient()
        let today = TodayModel(jarvis: JarvisClient())
        today.useHub(hub)
        Task { @MainActor in
            var failures = 0
            func check(_ ok: Bool, _ label: String) {
                print(ok ? "PASS" : "FAIL", label)
                if !ok { failures += 1 }
            }
            func wait(_ seconds: Double, until condition: () -> Bool) async -> Bool {
                let deadline = Date().addingTimeInterval(seconds)
                while !condition() && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
                return condition()
            }
            guard hub.isPaired else {
                print("This Mac isn't paired with the hub. Run Dash --hub-pair first.")
                exit(1)
            }
            hub.connect()
            check(await wait(20) { hub.isOnline }, "signs in to \(hub.credentials?.hub ?? "the hub")")
            check(!hub.devices.isEmpty, "gets the device list (\(hub.devices.map(\.name).joined(separator: ", ")))")
            today.refreshIfStale()
            let loaded = await wait(60) { today.events.value != nil && !today.isLoading }
            check(loaded, "Today loads from the hub")
            if let events = today.events.value {
                print("  \(events.count) events; first: \(events.first.map { "\($0.title) at \($0.start.formatted())" } ?? "none")")
            }
            if case .loaded(let weather) = today.weather { print("  weather: \(weather.prefix(70))") }
            if let mail = today.inbox.value { print("  inbox: \(mail.count) messages") }
            print("  brief: \(today.brief.turns.first?.text.prefix(80) ?? "(none yet)")…")

            let line = "Dash hub check \(UUID().uuidString.prefix(6)) (safe to delete)"
            let before = today.todos.items.map(\.text)
            today.todos.add(line)
            check(await wait(10) { today.todos.items.contains { $0.text == line } }, "adds a to-do through the hub")
            let mirrored = (try? String(contentsOf: Personal.todoURL, encoding: .utf8)) ?? ""
            check(mirrored.contains(line), "mirrors the list into the local todo.md for chats")
            if let item = today.todos.items.first(where: { $0.text == line }) { today.todos.delete(item) }
            check(await wait(10) { !today.todos.items.contains { $0.text == line } }, "removes it again")
            check(today.todos.items.map(\.text) == before, "leaves the list as it was")
            print(failures == 0 ? "\nAll hub client checks passed." : "\n\(failures) check(s) failed.")
            exit(failures == 0 ? 0 : 1)
        }
        NSApplication.shared.run()
    }
}

extension DebugPreview {
    /// `Dash --hub-memory-check [seconds]`: for a throwaway hub only (DASH_SUPPORT, DASH_HUB_CREDENTIALS).
    /// Queues 450 memory entries at once and checks they all go up in batches with none lost, and that the
    /// local memory.md's lines go up once. With `seconds`, it then prints every connection state change for
    /// that long, so stopping and restarting the hub by hand shows the backoff and the reconnect.
    static func hubMemoryCheck(_ arguments: [String]) {
        let hub = HubClient()
        let memory = MemoryModel.shared
        memory.useHub(hub)
        Task { @MainActor in
            var failures = 0
            func check(_ ok: Bool, _ label: String) {
                print(ok ? "PASS" : "FAIL", label)
                if !ok { failures += 1 }
            }
            func wait(_ seconds: Double, until condition: () -> Bool) async -> Bool {
                let deadline = Date().addingTimeInterval(seconds)
                while !condition() && Date() < deadline { try? await Task.sleep(nanoseconds: 100_000_000) }
                return condition()
            }
            guard hub.isPaired else { print("Not paired. Use --hub-pair with DASH_HUB_CREDENTIALS first."); exit(1) }
            hub.connect()
            check(await wait(20) { hub.isOnline }, "signs in")
            let uploaded = Personal.supportDir.appendingPathComponent("memory-uploaded.json")
            if FileManager.default.fileExists(atPath: Personal.memoryURL.path) {
                check(await wait(20) { FileManager.default.fileExists(atPath: uploaded.path) && memory.queuedCount == 0 },
                      "sends the local memory.md's lines and records them")
            }
            let tag = UUID().uuidString.prefix(6)
            for number in 1...450 { memory.log(source: "lens", kind: "question", text: "memory check \(tag) #\(number)") }
            check(await wait(60) { memory.queuedCount == 0 }, "all 450 entries go up (\(memory.queuedCount) still queued)")
            print("  the hub's log should now have 450 lines with \"memory check \(tag)\"")
            if let seconds = arguments.first.flatMap(Double.init) {
                print("Watching the connection for \(Int(seconds)) s; stop and restart the hub now.")
                let start = Date()
                let watch = hub.$state.removeDuplicates().sink { state in
                    print(String(format: "  %6.1f s  ", Date().timeIntervalSince(start)), state)
                }
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
                watch.cancel()
                check(hub.isPaired, "still paired at the end")
            }
            print(failures == 0 ? "\nAll hub memory checks passed." : "\n\(failures) check(s) failed.")
            exit(failures == 0 ? 0 : 1)
        }
        NSApplication.shared.run()
    }
}

extension DebugPreview {
    /// `Dash --login-item on|off|status`, run with the installed app's binary so it registers that app.
    static func loginItem(_ arguments: [String]) {
        do {
            switch arguments.first {
            case "on": try LoginItem.set(true)
            case "off": try LoginItem.set(false)
            default: break
            }
            let names: [SMAppService.Status: String] = [.enabled: "enabled", .notRegistered: "not registered",
                                                        .requiresApproval: "needs approval in System Settings › Login Items",
                                                        .notFound: "not found"]
            print("login item:", names[LoginItem.status] ?? "unknown", "·", Bundle.main.bundlePath)
            exit(0)
        } catch {
            print("login item failed:", error.localizedDescription)
            exit(1)
        }
    }
}
