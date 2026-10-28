import Foundation
import Network

/// A minimal MCP server on 127.0.0.1 that gives the advisor chat Robinhood's read-only tools.
/// Claude Code connects to it over HTTP; every call goes through Dash's own `RobinhoodClient`,
/// so the Robinhood login never leaves Dash, tokens refresh in one place, and the order tools
/// simply don't exist as far as Claude can tell. A random secret per launch keeps other local
/// programs out.
@MainActor
final class RobinhoodRelay {
    private let client: RobinhoodClient
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    let secret = UUID().uuidString + UUID().uuidString

    init(client: RobinhoodClient) {
        self.client = client
    }

    /// Starts listening on a free local port (once) and returns the `--mcp-config` entry.
    func start() async throws -> [String: Any] {
        if listener == nil {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            let listener = try NWListener(using: parameters)
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.serve(connection) }
            }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                // Clearing the handler on the first result means the continuation resumes once.
                listener.stateUpdateHandler = { [weak listener] state in
                    switch state {
                    case .ready:
                        listener?.stateUpdateHandler = nil
                        continuation.resume()
                    case .failed(let error):
                        listener?.stateUpdateHandler = nil
                        continuation.resume(throwing: error)
                    default:
                        break
                    }
                }
                listener.start(queue: .main)
            }
            port = listener.port?.rawValue ?? 0
            self.listener = listener
        }
        return ["type": "http", "url": "http://127.0.0.1:\(port)/mcp", "headers": ["Authorization": "Bearer \(secret)"]]
    }

    // MARK: HTTP

    private func serve(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(on: connection, buffer: Data())
    }

    /// Reads one HTTP request (headers + Content-Length body), answers it, and waits for the next.
    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self else { return }
                var buffer = buffer
                if let data { buffer.append(data) }
                guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                    if complete || error != nil { connection.cancel() } else { self.receive(on: connection, buffer: buffer) }
                    return
                }
                let head = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
                let lines = head.components(separatedBy: "\r\n")
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":") else { continue }
                    headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                }
                let length = Int(headers["content-length"] ?? "0") ?? 0
                let bodyStart = headerEnd.upperBound
                guard buffer.count - bodyStart >= length else {
                    self.receive(on: connection, buffer: buffer)
                    return
                }
                let body = buffer[bodyStart..<(bodyStart + length)]
                let rest = Data(buffer[(bodyStart + length)...])
                let method = lines.first?.split(separator: " ").first.map(String.init) ?? ""
                let (status, reply) = await self.handle(method: method, headers: headers, body: Data(body))
                self.send(status: status, json: reply, on: connection)
                if complete { connection.cancel() } else { self.receive(on: connection, buffer: rest) }
            }
        }
    }

    private func send(status: Int, json: [String: Any]?, on connection: NWConnection) {
        let body = json.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let reason = [200: "OK", 202: "Accepted", 401: "Unauthorized", 405: "Method Not Allowed", 400: "Bad Request"][status] ?? "OK"
        var head = "HTTP/1.1 \(status) \(reason)\r\nContent-Length: \(body.count)\r\n"
        if json != nil { head += "Content-Type: application/json\r\n" }
        head += "\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in })
    }

    // MARK: MCP

    private func handle(method: String, headers: [String: String], body: Data) async -> (Int, [String: Any]?) {
        guard headers["authorization"] == "Bearer \(secret)" else { return (401, nil) }
        // No server-to-client stream: Claude Code's optional GET is declined.
        guard method == "POST" else { return (405, nil) }
        guard let message = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return (400, nil) }
        guard let id = message["id"] else { return (202, nil) }  // a notification
        let params = message["params"] as? [String: Any] ?? [:]

        func reply(_ result: [String: Any]) -> (Int, [String: Any]?) {
            (200, ["jsonrpc": "2.0", "id": id, "result": result])
        }
        func failure(_ text: String) -> (Int, [String: Any]?) {
            reply(["content": [["type": "text", "text": text]], "isError": true])
        }

        switch message["method"] as? String {
        case "initialize":
            return reply(["protocolVersion": params["protocolVersion"] as? String ?? "2025-06-18",
                          "capabilities": ["tools": [:] as [String: Any]],
                          "serverInfo": ["name": "dash-robinhood-readonly", "version": "1"]])
        case "ping":
            return reply([:])
        case "tools/list":
            do {
                return reply(["tools": try await client.readToolDefinitions()])
            } catch {
                return (200, ["jsonrpc": "2.0", "id": id, "error": ["code": -32000, "message": error.localizedDescription]])
            }
        case "tools/call":
            let name = params["name"] as? String ?? ""
            guard RobinhoodClient.isReadOnly(name) else { return failure("Dash only reads from Robinhood; \(name) isn't available.") }
            do {
                let text = try await client.call(name, params["arguments"] as? [String: Any] ?? [:])
                return reply(["content": [["type": "text", "text": text]]])
            } catch {
                return failure(error.localizedDescription)
            }
        default:
            return (200, ["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found"]])
        }
    }
}
