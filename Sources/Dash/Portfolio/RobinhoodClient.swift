import AppKit
import CryptoKit
import Foundation
import Network
import Security

enum RobinhoodError: LocalizedError {
    case notConnected
    case blocked(String)
    case auth(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .notConnected: "Robinhood isn't connected. Use Connect on the Portfolio page."
        case .blocked(let tool): "Dash only reads from Robinhood; \(tool) isn't allowed."
        case .auth(let message): "Robinhood sign-in: \(message)"
        case .failed(let message): message
        }
    }
}

/// Dash's own read-only connection to Robinhood's official MCP server
/// (agent.robinhood.com/mcp/trading). It signs in with standard MCP OAuth (dynamic client
/// registration + PKCE, tokens in Dash's Keychain) and calls tools directly over streamable
/// HTTP, so live portfolio updates never go through Claude and cost no tokens.
///
/// The server can also place trades (in Robinhood's separate Agentic account). Dash never
/// does: `call` refuses every tool that isn't on the read-only allowlist, before any request.
@MainActor
final class RobinhoodClient {
    static let endpoint = URL(string: "https://agent.robinhood.com/mcp/trading")!
    static let registerURL = URL(string: "https://agent.robinhood.com/oauth/trading/register")!
    static let authorizeURL = URL(string: "https://robinhood.com/oauth")!
    static let tokenURL = URL(string: "https://api.robinhood.com/oauth2/token/")!
    /// Fixed loopback port for the sign-in redirect (registered with Robinhood once).
    static let callbackPort: UInt16 = 47823
    static var redirectURI: String { "http://127.0.0.1:\(callbackPort)/callback" }

    /// The only tools Dash will ever call, for the page and the advisor chat. Anything else,
    /// including every order tool, is refused.
    static let readTools: Set<String> = [
        // Account and positions
        "get_accounts", "get_portfolio", "get_equity_positions", "get_crypto_positions", "get_option_positions",
        "get_realized_pnl", "get_pnl_trade_history", "get_equity_tax_lots",
        // Prices and history
        "get_equity_quotes", "get_equity_historicals", "get_crypto_quotes", "get_indexes", "get_index_quotes",
        "get_index_historicals", "get_equity_technical_indicators",
        // Research
        "get_equity_fundamentals", "get_financials", "get_equity_analyst_ratings", "get_earnings_calendar",
        "get_earnings_results", "get_sec_filing", "get_sec_filing_index", "get_sec_filing_facts",
        "get_sec_filing_facts_catalog",
        // Options research (reading chains and quotes only)
        "get_option_chains", "get_option_instruments", "get_option_quotes",
    ]
    /// Belt and braces: every Robinhood read tool starts with "get_" and none of its write tools
    /// do, and nothing about orders or trade approvals is read either.
    private static let blockedWords = ["order", "approval"]

    static func isReadOnly(_ tool: String) -> Bool {
        let lower = tool.lowercased()
        return readTools.contains(tool) && lower.hasPrefix("get_") && !blockedWords.contains { lower.contains($0) }
    }

    /// Read from the Keychain on first use, not at launch: after every rebuild macOS asks before
    /// Dash may read the secret, and a launch-time read would hold up all of Dash until answered.
    private var tokens: Tokens? {
        get {
            if !tokensLoaded {
                storedTokens = Keychain.load()
                tokensLoaded = true
            }
            return storedTokens
        }
        set {
            storedTokens = newValue
            tokensLoaded = true
        }
    }
    private var storedTokens: Tokens?
    private var tokensLoaded = false
    private var sessionID: String?
    private var nextID = 1

    /// Whether a login is saved. Before the token is needed this only checks that the Keychain item
    /// exists, which doesn't ask for access.
    var isConnected: Bool { tokensLoaded ? storedTokens != nil : Keychain.exists() }

    // MARK: Tools

    /// Calls a read-only tool and returns its text content.
    func call(_ tool: String, _ arguments: [String: Any] = [:]) async throws -> String {
        guard Self.isReadOnly(tool) else { throw RobinhoodError.blocked(tool) }
        let result = try await rpc("tools/call", ["name": tool, "arguments": arguments])
        let blocks = result["content"] as? [[String: Any]] ?? []
        let text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
        if result["isError"] as? Bool == true { throw RobinhoodError.failed(text.isEmpty ? "\(tool) failed." : text) }
        return text
    }

    /// The server's tool list (names, descriptions, input schemas). Listing calls nothing.
    func listTools() async throws -> [[String: Any]] {
        try await rpc("tools/list", [:])["tools"] as? [[String: Any]] ?? []
    }

    private var readDefinitions: [[String: Any]]?

    /// Definitions of just the read-only tools, as the advisor's relay offers them to Claude.
    func readToolDefinitions() async throws -> [[String: Any]] {
        if let readDefinitions { return readDefinitions }
        let tools = try await listTools().filter { Self.isReadOnly($0["name"] as? String ?? "") }
        readDefinitions = tools
        return tools
    }

    func disconnect() {
        tokens = nil
        sessionID = nil
        Keychain.delete()
    }

    // MARK: Streamable HTTP MCP

    private func rpc(_ method: String, _ params: [String: Any], retried: Bool = false) async throws -> [String: Any] {
        guard tokens != nil else { throw RobinhoodError.notConnected }
        if sessionID == nil && method != "initialize" { try await initialize() }
        do {
            return try await post(method, params)
        } catch RobinhoodHTTP.unauthorized where !retried {
            try await refresh()
            return try await rpc(method, params, retried: true)
        } catch RobinhoodHTTP.sessionExpired where !retried {
            sessionID = nil
            return try await rpc(method, params, retried: true)
        }
    }

    private func initialize() async throws {
        _ = try await post("initialize", ["protocolVersion": "2025-06-18", "capabilities": [:] as [String: Any],
                                          "clientInfo": ["name": "dash", "version": "0.3"]])
        _ = try? await post("notifications/initialized", nil)
    }

    private enum RobinhoodHTTP: Error { case unauthorized, sessionExpired }

    /// One JSON-RPC message. Notifications (`params == nil`) expect no result.
    private func post(_ method: String, _ params: [String: Any]?) async throws -> [String: Any] {
        guard let token = tokens?.access else { throw RobinhoodError.notConnected }
        var message: [String: Any] = ["jsonrpc": "2.0", "method": method]
        let id = nextID
        if let params {
            message["id"] = id
            message["params"] = params
            nextID += 1
        }
        var request = URLRequest(url: Self.endpoint, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: message)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let sessionID {
            request.setValue(sessionID, forHTTPHeaderField: "Mcp-Session-Id")
            request.setValue("2025-06-18", forHTTPHeaderField: "MCP-Protocol-Version")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        if http?.statusCode == 401 { throw RobinhoodHTTP.unauthorized }
        if http?.statusCode == 404 && sessionID != nil { throw RobinhoodHTTP.sessionExpired }
        guard let http, (200..<300).contains(http.statusCode) else {
            throw RobinhoodError.failed("Robinhood returned \(http?.statusCode ?? 0): \(String(decoding: data.prefix(300), as: UTF8.self))")
        }
        if let session = http.value(forHTTPHeaderField: "Mcp-Session-Id") { sessionID = session }
        guard params != nil else { return [:] }

        // The reply is plain JSON or a short SSE stream whose "data:" lines carry the message.
        let body = String(decoding: data, as: UTF8.self)
        let candidates = (http.value(forHTTPHeaderField: "Content-Type") ?? "").contains("event-stream")
            ? body.components(separatedBy: "\n").filter { $0.hasPrefix("data:") }.map { String($0.dropFirst(5)) }
            : [body]
        for candidate in candidates {
            guard let json = try? JSONSerialization.jsonObject(with: Data(candidate.utf8)) as? [String: Any],
                  (json["id"] as? Int) == id
            else { continue }
            if let error = json["error"] as? [String: Any] {
                throw RobinhoodError.failed(error["message"] as? String ?? "Robinhood error")
            }
            return json["result"] as? [String: Any] ?? [:]
        }
        throw RobinhoodError.failed("Robinhood sent no reply to \(method).")
    }

    // MARK: OAuth

    struct Tokens: Codable {
        var access: String
        var refresh: String?
        var expires: Date?
    }

    private static let clientIDKey = "robinhoodClientID"

    /// Opens Robinhood's sign-in in the browser and waits for the redirect back to Dash.
    func connect() async throws {
        let clientID = try await registeredClientID()
        let verifier = Self.randomString(64)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let state = Self.randomString(24)

        var components = URLComponents(url: Self.authorizeURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: clientID),
            .init(name: "redirect_uri", value: Self.redirectURI),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "state", value: state),
            .init(name: "scope", value: "internal"),
            .init(name: "resource", value: Self.endpoint.absoluteString),
        ]
        let callback = LoopbackCallback(port: Self.callbackPort)
        try callback.start()
        NSWorkspace.shared.open(components.url!)
        let query = try await callback.wait(timeout: 300)

        if let error = query["error"] { throw RobinhoodError.auth(query["error_description"] ?? error) }
        guard query["state"] == state, let code = query["code"] else {
            throw RobinhoodError.auth("The sign-in reply didn't match this request. Try again.")
        }
        try await exchange(["grant_type": "authorization_code", "code": code, "redirect_uri": Self.redirectURI,
                            "client_id": clientID, "code_verifier": verifier,
                            "resource": Self.endpoint.absoluteString])
        sessionID = nil
    }

    private func refresh() async throws {
        guard let refreshToken = tokens?.refresh,
              let clientID = UserDefaults.standard.string(forKey: Self.clientIDKey)
        else {
            disconnect()
            throw RobinhoodError.auth("Your Robinhood session ended. Connect again.")
        }
        do {
            try await exchange(["grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": clientID,
                                "resource": Self.endpoint.absoluteString])
        } catch {
            disconnect()
            throw RobinhoodError.auth("Your Robinhood session ended. Connect again.")
        }
    }

    private func exchange(_ form: [String: String]) async throws {
        var request = URLRequest(url: Self.tokenURL, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(form.map { "\($0.key)=\($0.value.formEncoded)" }.joined(separator: "&").utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let access = json["access_token"] as? String
        else {
            throw RobinhoodError.auth(String(decoding: data.prefix(300), as: UTF8.self))
        }
        let expires = (json["expires_in"] as? NSNumber).map { Date().addingTimeInterval($0.doubleValue) }
        let tokens = Tokens(access: access, refresh: json["refresh_token"] as? String ?? tokens?.refresh, expires: expires)
        self.tokens = tokens
        Keychain.save(tokens)
    }

    /// Registers Dash as an OAuth client once; the client id isn't secret, so it lives in defaults.
    private func registeredClientID() async throws -> String {
        if let id = UserDefaults.standard.string(forKey: Self.clientIDKey) { return id }
        var request = URLRequest(url: Self.registerURL, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "client_name": "Dash", "redirect_uris": [Self.redirectURI],
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
            "token_endpoint_auth_method": "none", "scope": "internal",
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["client_id"] as? String
        else {
            throw RobinhoodError.auth("Couldn't register Dash with Robinhood: \(String(decoding: data.prefix(300), as: UTF8.self))")
        }
        UserDefaults.standard.set(id, forKey: Self.clientIDKey)
        return id
    }

    private static func randomString(_ length: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        return String(Data(bytes).base64URL.prefix(length))
    }

    // MARK: Keychain

    private enum Keychain {
        static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                           kSecAttrService as String: "Dash Robinhood",
                                           kSecAttrAccount as String: "oauth"]

        static func load() -> Tokens? {
            var item: CFTypeRef?
            var lookup = query
            lookup[kSecReturnData as String] = true
            guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess, let data = item as? Data
            else { return nil }
            return try? JSONDecoder().decode(Tokens.self, from: data)
        }

        static func exists() -> Bool {
            var lookup = query
            lookup[kSecReturnAttributes as String] = true
            return SecItemCopyMatching(lookup as CFDictionary, nil) == errSecSuccess
        }

        static func save(_ tokens: Tokens) {
            guard let data = try? JSONEncoder().encode(tokens) else { return }
            SecItemDelete(query as CFDictionary)
            var item = query
            item[kSecValueData as String] = data
            SecItemAdd(item as CFDictionary, nil)
        }

        static func delete() {
            SecItemDelete(query as CFDictionary)
        }
    }
}

/// A one-shot HTTP listener on 127.0.0.1 that catches the OAuth redirect.
final class LoopbackCallback: @unchecked Sendable {
    private let port: UInt16
    private var listener: NWListener?
    private var continuation: CheckedContinuation<[String: String], Error>?
    private let lock = NSLock()

    init(port: UInt16) {
        self.port = port
    }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in self?.handle(connection) }
        listener.start(queue: .global())
        self.listener = listener
    }

    func wait(timeout: TimeInterval) async throws -> [String: String] {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish(.failure(RobinhoodError.auth("Timed out waiting for the Robinhood sign-in.")))
            }
        }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: .global())
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
            let request = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            // "GET /callback?code=…&state=… HTTP/1.1"
            let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? ""
            guard target.hasPrefix("/callback") else {
                connection.send(content: Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".utf8),
                                completion: .contentProcessed { _ in connection.cancel() })
                return
            }
            var query: [String: String] = [:]
            for item in URLComponents(string: target)?.queryItems ?? [] { query[item.name] = item.value ?? "" }
            let page = "<html><body style=\"font-family:-apple-system;padding:40px\"><h2>Dash is connected to Robinhood.</h2><p>You can close this tab.</p></body></html>"
            let reply = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(page.utf8.count)\r\nConnection: close\r\n\r\n\(page)"
            connection.send(content: Data(reply.utf8), completion: .contentProcessed { _ in connection.cancel() })
            self?.finish(.success(query))
        }
    }

    private func finish(_ result: Result<[String: String], Error>) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        listener?.cancel()
        continuation?.resume(with: result)
    }
}

private extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension String {
    var formEncoded: String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? self
    }
}
