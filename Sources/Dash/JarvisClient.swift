import Foundation

enum JarvisError: LocalizedError {
    case notInstalled
    case stopped(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .notInstalled:
            "Couldn't find jarvis at ~/.claude/mcp-servers/jarvis-mcp."
        case .stopped(let detail):
            detail.isEmpty ? "jarvis stopped unexpectedly." : "jarvis stopped: \(detail.suffix(300))"
        case .failed(let message):
            message
        }
    }
}

/// Dash's own long-lived jarvis MCP server, spoken to directly over stdio (newline-delimited
/// JSON-RPC). Today's tiles and the lecture buttons call tools through this without going
/// through Claude. It has to be one persistent process because lecture recording lives
/// inside it: a jarvis started by a short-lived chat would take the recording down with it.
@MainActor
final class JarvisClient {
    static let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/mcp-servers/jarvis-mcp", isDirectory: true)
    static let python = directory.appendingPathComponent(".venv/bin/python")
    static let server = directory.appendingPathComponent("server.py")

    static var isInstalled: Bool {
        FileManager.default.isExecutableFile(atPath: python.path)
            && FileManager.default.fileExists(atPath: server.path)
    }

    /// The same server as an `--mcp-config` entry, for chats that start their own copy.
    static var mcpConfigJSON: String {
        let config: [String: Any] = ["mcpServers": ["jarvis": ["type": "stdio", "command": python.path,
                                                               "args": [server.path]]]]
        let data = (try? JSONSerialization.data(withJSONObject: config)) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    private var process: Process?
    private var input: Pipe?
    private var buffer = Data()
    private var stderrTail = ""
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var ready: Task<Void, Error>?

    var isRunning: Bool { process?.isRunning == true }

    /// Calls a jarvis tool and returns its text output. jarvis reports most problems
    /// (missing Google token, unknown course…) as ordinary text, so read the result.
    func call(_ tool: String, _ arguments: [String: Any] = [:]) async throws -> String {
        try await start()
        let result = try await request("tools/call", ["name": tool, "arguments": arguments])
        let blocks = result["content"] as? [[String: Any]] ?? []
        let text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
        if result["isError"] as? Bool == true { throw JarvisError.failed(text.isEmpty ? "\(tool) failed." : text) }
        return text
    }

    /// Starts jarvis if it isn't running and waits for the MCP handshake.
    func start() async throws {
        if let ready, isRunning { return try await ready.value }
        guard Self.isInstalled else { throw JarvisError.notInstalled }

        let process = Process()
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.executableURL = Self.python
        process.arguments = [Self.server.path]
        process.currentDirectoryURL = Self.directory
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        buffer = Data()
        stderrTail = ""

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.readAvailable()
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.receive(data) } }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.readAvailable()
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.stderrTail = String((self.stderrTail + String(decoding: data, as: UTF8.self)).suffix(2000))
                }
            }
        }
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.process === ended else { return }
                    Log.write("jarvis exited (status \(ended.terminationStatus)): \(self.stderrTail.suffix(200))")
                    self.failAll(JarvisError.stopped(self.stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)))
                    self.process = nil
                    self.ready = nil
                }
            }
        }
        try process.run()
        self.process = process
        self.input = input

        let ready = Task {
            _ = try await self.request("initialize", [
                "protocolVersion": "2025-06-18", "capabilities": [:] as [String: Any],
                "clientInfo": ["name": "dash", "version": "0.2"],
            ])
            try self.write(["jsonrpc": "2.0", "method": "notifications/initialized"])
        }
        self.ready = ready
        do {
            try await ready.value
        } catch {
            // A failed handshake would otherwise stick until Dash restarts; drop this process
            // so the next call starts a fresh one.
            if self.process === process {
                self.process = nil
                self.ready = nil
                process.terminate()
            }
            throw error
        }
    }

    /// Closes jarvis's stdin so it exits on its own and its shutdown handler can stop an active
    /// recording cleanly. With `wait` (at quit) it blocks up to two seconds for that, then terminates
    /// it, since a timer wouldn't survive Dash exiting. Without it, it's terminated after a few seconds.
    func shutdown(wait: Bool = false) {
        guard let process, process.isRunning else { return }
        try? input?.fileHandleForWriting.close()
        if wait {
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < deadline { usleep(50_000) }
            if process.isRunning { process.terminate() }
        } else {
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                if process.isRunning { process.terminate() }
            }
        }
    }

    /// Long enough for the first Google sign-in in a browser; a hung call fails instead of
    /// leaving Today stuck on "Loading…".
    static let timeout: UInt64 = 180

    private func request(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
        let id = nextID
        nextID += 1
        Task {
            try? await Task.sleep(nanoseconds: Self.timeout * 1_000_000_000)
            // A late reply finds nothing pending and is ignored.
            pending.removeValue(forKey: id)?.resume(throwing: JarvisError.failed("jarvis didn't answer \(method) in time."))
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do {
                try write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
            } catch {
                pending[id] = nil
                continuation.resume(throwing: error)
            }
        }
    }

    private func write(_ message: [String: Any]) throws {
        guard let input, isRunning else { throw JarvisError.stopped(stderrTail) }
        var line = try JSONSerialization.data(withJSONObject: message)
        line.append(0x0A)
        try input.fileHandleForWriting.write(contentsOf: line)
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let id = message["id"] as? Int, let continuation = pending.removeValue(forKey: id)
            else { continue }
            if let error = message["error"] as? [String: Any] {
                continuation.resume(throwing: JarvisError.failed(error["message"] as? String ?? "jarvis error"))
            } else {
                continuation.resume(returning: message["result"] as? [String: Any] ?? [:])
            }
        }
    }

    private func failAll(_ error: Error) {
        let waiting = pending
        pending = [:]
        for continuation in waiting.values { continuation.resume(throwing: error) }
    }
}
