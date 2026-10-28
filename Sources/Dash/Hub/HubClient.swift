import AppKit
import Foundation
import Security

/// Mac Dash's connection to the Dash hub on the always-on PC (hub/src/server.ts), the Swift twin of the
/// phone's `mobile/src/lib/hub.ts`. The hub owns the shared data (to-do list, Today, the brief); this
/// Mac and the phone are both clients of it. One WebSocket carries everything:
///   Mac → hub  {"id": 7, "type": "todo.add", "text": "…"}
///   hub → Mac  {"re": 7, "ok": true, "result": {…}}  or  {"re": 7, "ok": false, "error": "…"}
///   hub → Mac  {"event": "todo", "data": {…}}        whenever something changes
/// The latest copy of every event is saved to disk, so Today and the to-do list open with something
/// on screen and stay readable while the hub can't be reached.
@MainActor
final class HubClient: ObservableObject {
    enum State: Equatable {
        case unpaired
        case connecting
        case online
        case offline(String)
    }

    struct Credentials: Codable, Equatable {
        var url: String
        var token: String
        /// The hub's name ("dash-hub") and the name it knows this Mac by.
        var hub: String
        var device: String
        /// The phone app's Expo Go address, when the hub knows it.
        var app: String?
    }

    struct Device: Identifiable, Equatable {
        let id: String
        let name: String
        let role: String
        let online: Bool
        let lastSeen: Date?
    }

    struct HubError: LocalizedError {
        let message: String
        /// The hub answered and said no, as opposed to the connection failing.
        var fromHub = false
        /// The hub's machine-readable reason, when it gives one ("unknown_token").
        var code: String?
        var errorDescription: String? { message }
    }

    /// Empty: each setup has its own tailnet name, so Settings asks for it (wss://dash-hub.<tailnet>.ts.net).
    static let defaultURL = ""

    @Published private(set) var state: State = .unpaired
    @Published private(set) var credentials: Credentials?
    /// Every paired device. The hub sends this to Macs only, for Settings.
    @Published private(set) var devices: [Device] = []
    /// What the hub's health check found wrong (expired sign-ins, sync stopped…), for a banner on Today.
    @Published private(set) var problems: [String] = []
    /// Set when the pairing couldn't be saved, so it would be gone at the next launch; Settings shows it.
    @Published private(set) var storeError: String?

    private let store: CredentialStore
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    /// Bumped on every new connection, so callbacks from an old socket can't touch the new one.
    private var generation = 0
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var listeners: [String: [([String: Any]) -> Void]] = [:]
    private var backoff: TimeInterval = 1
    private var retry: DispatchWorkItem?
    private var pingTimer: Timer?
    /// The connection whose sign-in is on its way, so a wake or a Retry click doesn't start a second one.
    private var signingIn: Int?
    /// A heartbeat ping is waiting for its answer.
    private var pinging = false

    /// Nonisolated because default arguments below use it.
    nonisolated private static let requestTimeout: TimeInterval = 15
    /// Retries wait 1, 2, 4… seconds up to a minute, each stretched or shrunk by up to a quarter so the
    /// Mac and the phone don't knock in step after the hub comes back.
    private static let maxBackoff: TimeInterval = 60
    private static let pingInterval: TimeInterval = 30
    /// DASH_HUB_CACHE moves it, so command-line tests don't touch the app's saved copies.
    static let cacheDir = ProcessInfo.processInfo.environment["DASH_HUB_CACHE"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? Personal.supportDir.appendingPathComponent("hub-cache", isDirectory: true)

    /// `store: .none` is for previews: never paired, never touches the Keychain.
    init(store: CredentialStore = .standardOrOverride) {
        self.store = store
        credentials = store.load()
        state = credentials == nil ? .unpaired : .offline("Not connected yet.")
        on("devices") { [weak self] data in self?.devices = Self.parseDevices(data) }
        on("health") { [weak self] data in
            self?.problems = (data["problems"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
        }
        // A sleeping Mac drops its connection, often without a close, so the state can still say online.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil,
                                                          queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkAfterWake() }
        }
    }

    var isPaired: Bool { credentials != nil }
    var isOnline: Bool { state == .online }

    /// Sample data for `Dash --preview settings`; nothing is saved or sent.
    func showSample(_ credentials: Credentials, devices: [Device], state: State) {
        self.credentials = credentials
        self.devices = devices
        self.state = state
    }

    /// Signs in with the saved pairing. Retries come through here too, so the backoff is left alone;
    /// only a successful sign-in resets it. `quietly` keeps the offline reason on screen during the
    /// attempt instead of flicking to "Connecting…" on every retry.
    func connect(quietly: Bool = false) {
        guard let credentials else { state = .unpaired; return }
        Task { try? await open(credentials.url, signIn: ("hello", ["token": credentials.token]), quietly: quietly) }
    }

    /// Try again now rather than at the next backoff step.
    func reconnectNow() {
        guard isPaired, state != .online, signingIn == nil else { return }
        retry?.cancel()
        connect()
    }

    /// After sleep: a connection that says it's online has to answer a quick ping or it's replaced, and
    /// an offline one tries again now instead of waiting out the backoff.
    private func checkAfterWake() {
        guard isPaired else { return }
        if state == .online, let task {
            heartbeat(task, generation, timeout: 5)
        } else {
            reconnectNow()
        }
    }

    /// Pairs this Mac with a code from the hub (`npm run pair` on the hub, or another Mac's Settings).
    func pair(url: String, code: String) async throws {
        let address = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = Host.current().localizedName ?? "Mac"
        let result = try await open(address, signIn: ("pair", ["code": code.trimmingCharacters(in: .whitespaces),
                                                                "name": name, "role": "mac"]))
        guard let token = result["token"] as? String else { throw HubError(message: "The hub didn't send a sign-in token.") }
        let paired = Credentials(url: address, token: token, hub: result["hub"] as? String ?? "Dash hub",
                                 device: result["device"] as? String ?? name, app: result["app"] as? String)
        credentials = paired
        Log.write("hub: paired with \(paired.hub) as \(paired.device)")
        persist(paired)
    }

    /// Saves the pairing. If the Keychain refuses, this session keeps working, Settings says the pairing
    /// won't survive a relaunch, and each sign-in tries saving it again.
    private func persist(_ credentials: Credentials) {
        do {
            try store.save(credentials)
            storeError = nil
        } catch {
            Log.write("hub: \(error.localizedDescription)")
            storeError = "\(error.localizedDescription) Dash stays paired until it quits, and tries saving again each time it connects."
        }
    }

    /// Forgets the hub on this Mac. The hub still lists this Mac until it's removed there.
    func unpair() {
        store.delete()
        credentials = nil
        generation += 1
        retry?.cancel()
        pingTimer?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        failPending("Unpaired.")
        try? FileManager.default.removeItem(at: Self.cacheDir)
        devices = []
        storeError = nil
        state = .unpaired
    }

    func request(_ type: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        guard let task, state == .online else { throw HubError(message: offlineMessage) }
        return try await send(task, type, params)
    }

    var offlineMessage: String {
        if case .offline(let reason) = state { return reason }
        return "Not connected to the Dash hub."
    }

    /// Calls `handler` with every `event` the hub pushes, starting with the saved copy if there is one.
    func on(_ event: String, _ handler: @escaping ([String: Any]) -> Void) {
        listeners[event, default: []].append(handler)
        if isPaired, !Self.unsaved.contains(event), let saved = cached(event) { handler(saved) }
    }

    /// Events that are instructions, not data: never saved, so a relaunch can't replay "start recording".
    private static let unsaved: Set<String> = ["command"]

    /// When the saved copy of an event was last updated, for "showing the copy from 12:41".
    func cacheDate(_ event: String) -> Date? {
        let url = Self.cacheDir.appendingPathComponent("\(event).json")
        return (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }

    // MARK: Connection

    @discardableResult
    private func open(_ address: String, signIn: (String, [String: Any]), quietly: Bool = false) async throws -> [String: Any] {
        guard let url = URL(string: address), url.scheme == "wss" || url.scheme == "ws" else {
            throw HubError(message: "\"\(address)\" isn't a hub address. It looks like wss://dash-hub.….ts.net.")
        }
        generation += 1
        let current = generation
        retry?.cancel()
        pingTimer?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
        failPending("Reconnecting.")
        if !quietly || state == .online { state = .connecting }
        signingIn = current
        defer { if signingIn == current { signingIn = nil } }
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 32 << 20
        self.task = task
        task.resume()
        receive(task, current)
        do {
            let result = try await send(task, signIn.0, signIn.1)
            guard current == generation else { throw HubError(message: "Replaced by a newer connection.") }
            backoff = 1
            state = .online
            if let app = result["app"] as? String, var credentials, credentials.app != app {
                credentials.app = app
                self.credentials = credentials
                persist(credentials)
            } else if storeError != nil, let credentials {
                persist(credentials)
            }
            startPinging(task, current)
            return result
        } catch let error as HubError where error.fromHub {
            guard current == generation else { throw error }
            // Retire this socket first, so its closing isn't also taken for a dropped connection.
            generation += 1
            task.cancel(with: .goingAway, reason: nil)
            self.task = nil
            if signIn.0 == "hello" && error.code == "unknown_token" {
                // The hub no longer knows this Mac (it was removed), so only pairing again can help.
                Log.write("hub: sign-in refused, forgetting the pairing: \(error.message)")
                unpair()
            } else {
                // Anything else (the hub starting up, a damaged file on it) is the hub's to fix: keep the
                // pairing and the queued memory, and keep trying.
                if signIn.0 == "hello", state != .offline(error.message) { Log.write("hub: sign-in failed: \(error.message)") }
                state = isPaired ? .offline(error.message) : .unpaired
                if isPaired { scheduleRetry() }
            }
            throw error
        } catch {
            if current == generation { dropped(current, error.localizedDescription) }
            throw HubError(message: "Couldn't reach the Dash hub. Is Tailscale on, and is the PC on and signed in?")
        }
    }

    private func receive(_ task: URLSessionWebSocketTask, _ current: Int) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, current == self.generation else { return }
                    switch result {
                    case .failure(let error):
                        self.dropped(current, error.localizedDescription)
                    case .success(let message):
                        if case .string(let text) = message,
                           let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
                            self.handle(object)
                        }
                        self.receive(task, current)
                    }
                }
            }
        }
    }

    private func handle(_ message: [String: Any]) {
        if let id = message["re"] as? Int {
            guard let waiting = pending.removeValue(forKey: id) else { return }
            if message["ok"] as? Bool == true {
                waiting.resume(returning: message["result"] as? [String: Any] ?? [:])
            } else {
                waiting.resume(throwing: HubError(message: message["error"] as? String ?? "The hub refused.", fromHub: true,
                                                  code: message["code"] as? String))
            }
        } else if let event = message["event"] as? String {
            let data = message["data"] as? [String: Any] ?? [:]
            if !Self.unsaved.contains(event) { save(event, data) }
            listeners[event]?.forEach { $0(data) }
        }
    }

    private func dropped(_ current: Int, _ reason: String) {
        guard current == generation else { return }
        generation += 1
        pingTimer?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        failPending("Lost the connection to the Dash hub.")
        guard isPaired else { state = .unpaired; return }
        if state == .online { Log.write("hub: disconnected (\(reason))") }
        state = .offline("Can't reach the Dash hub. Check that Tailscale is on; if it is, the PC may be off or signed out.")
        scheduleRetry()
    }

    private func scheduleRetry() {
        retry?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.connect(quietly: true) } }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff * Double.random(in: 0.75...1.25), execute: work)
        backoff = min(backoff * 2, Self.maxBackoff)
    }

    /// A connection can die without a close (Wi-Fi change, sleep, the PC restarting), and a WebSocket
    /// ping can go unanswered without ever failing; a `ping` request every 30 s notices within 45.
    private func startPinging(_ task: URLSessionWebSocketTask, _ current: Int) {
        pingTimer?.invalidate()
        pinging = false
        pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, current == self.generation, !self.pinging else { return }
                self.heartbeat(task, current)
            }
        }
    }

    /// Any answer proves the connection is alive, even a refusal from an older hub that has no `ping`;
    /// silence or a failed send means it's dead, so start over.
    private func heartbeat(_ task: URLSessionWebSocketTask, _ current: Int, timeout: TimeInterval = requestTimeout) {
        pinging = true
        Task {
            defer { if current == generation { pinging = false } }
            do {
                _ = try await send(task, "ping", [:], timeout: timeout)
            } catch let error as HubError where error.fromHub {
                return
            } catch {
                dropped(current, "no answer to ping")
            }
        }
    }

    private func send(_ task: URLSessionWebSocketTask, _ type: String, _ params: [String: Any],
                      timeout: TimeInterval = requestTimeout) async throws -> [String: Any] {
        let id = nextID
        nextID += 1
        var message = params
        message["id"] = id
        message["type"] = type
        let data = try JSONSerialization.data(withJSONObject: message)
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            task.send(.string(String(decoding: data, as: UTF8.self))) { [weak self] error in
                guard let error else { return }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated { self?.pending.removeValue(forKey: id)?.resume(throwing: error) }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                MainActor.assumeIsolated {
                    self?.pending.removeValue(forKey: id)?.resume(throwing: HubError(message: "The Dash hub took too long to answer."))
                }
            }
        }
    }

    private func failPending(_ reason: String) {
        let waiting = pending
        pending = [:]
        for continuation in waiting.values { continuation.resume(throwing: HubError(message: reason)) }
    }

    // MARK: Saved copies

    private func save(_ event: String, _ data: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(data), let json = try? JSONSerialization.data(withJSONObject: data) else { return }
        try? FileManager.default.createDirectory(at: Self.cacheDir, withIntermediateDirectories: true)
        try? json.write(to: Self.cacheDir.appendingPathComponent("\(event).json"), options: .atomic)
    }

    private func cached(_ event: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: Self.cacheDir.appendingPathComponent("\(event).json")) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// Not tied to the main actor: HubJSON's decoder calls `date` from a nonisolated closure, and
    /// ISO8601DateFormatter is safe to use from any thread once it's set up.
    nonisolated(unsafe) static let isoDate: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// The hub sends JavaScript dates ("2026-10-27T14:05:00.000Z"); accept them with or without milliseconds.
    nonisolated static func date(_ value: Any?) -> Date? {
        guard let string = value as? String else { return nil }
        return isoDate.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }

    private static func parseDevices(_ data: [String: Any]) -> [Device] {
        (data["devices"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let id = entry["id"] as? String, let name = entry["name"] as? String else { return nil }
            return Device(id: id, name: name, role: entry["role"] as? String ?? "phone",
                          online: entry["online"] as? Bool ?? false, lastSeen: date(entry["lastSeen"]))
        }
    }
}

/// Where the hub sign-in lives: the Keychain normally, a file for command-line tests run with the debug
/// build (which isn't signed like the app, so the Keychain would keep asking), nowhere for previews.
enum CredentialStore {
    case standard
    case file(URL)
    case none

    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                               kSecAttrService as String: "Dash Hub",
                                               kSecAttrAccount as String: "credentials"]

    /// `DASH_HUB_CREDENTIALS=/path/file.json` swaps the Keychain for that file.
    static var standardOrOverride: CredentialStore {
        ProcessInfo.processInfo.environment["DASH_HUB_CREDENTIALS"].map { .file(URL(fileURLWithPath: $0)) } ?? .standard
    }

    func load() -> HubClient.Credentials? {
        let data: Data?
        switch self {
        case .standard:
            var item: CFTypeRef?
            var lookup = Self.query
            lookup[kSecReturnData as String] = true
            data = SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess ? item as? Data : nil
        case .file(let url):
            data = try? Data(contentsOf: url)
        case .none:
            data = nil
        }
        return data.flatMap { try? JSONDecoder().decode(HubClient.Credentials.self, from: $0) }
    }

    /// Throws when the pairing couldn't be kept, rather than letting it vanish at the next launch.
    func save(_ credentials: HubClient.Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        switch self {
        case .standard:
            SecItemDelete(Self.query as CFDictionary)
            var item = Self.query
            item[kSecValueData as String] = data
            let status = SecItemAdd(item as CFDictionary, nil)
            guard status == errSecSuccess else {
                let reason = SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)"
                throw HubClient.HubError(message: "Couldn't save the hub pairing to the Keychain (\(reason)).")
            }
        case .file(let url):
            guard FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                throw HubClient.HubError(message: "Couldn't save the hub pairing to \(url.path).")
            }
        case .none:
            break
        }
    }

    func delete() {
        switch self {
        case .standard: SecItemDelete(Self.query as CFDictionary)
        case .file(let url): try? FileManager.default.removeItem(at: url)
        case .none: break
        }
    }
}
