import Foundation

/// A tiny append-only log in Application Support/Dash/dash.log, so a quit, a failed
/// hotkey or a dead child process leaves a trace. Trimmed at launch once it passes 256 KB.
enum Log {
    private static let queue = DispatchQueue(label: "dash.log")
    private static let url = Personal.supportDir.appendingPathComponent("dash.log")
    private static let stamp: ISO8601DateFormatter = ISO8601DateFormatter()

    static func write(_ message: String) {
        let line = "\(stamp.string(from: Date())) \(message)\n"
        queue.async {
            guard let data = line.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            } else {
                try? data.write(to: url)
            }
        }
    }

    static func trimIfLarge() {
        queue.async {
            guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int,
                  size > 256_000, let text = try? String(contentsOf: url, encoding: .utf8) else { return }
            try? String(text.suffix(64_000)).write(to: url, atomically: true, encoding: .utf8)
        }
    }
}
