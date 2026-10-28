import Foundation

extension FileHandle {
    /// Whatever bytes are available right now (blocking only until there's at least one), or empty
    /// at end of file. A plain POSIX read: `read(upToCount:)` waits for the whole count on a pipe,
    /// and `availableData` raises an Objective-C exception (which Swift can't catch) if the pipe is
    /// closed underneath it. Safe to call from a readability handler.
    nonisolated func readAvailable() -> Data {
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = Darwin.read(fileDescriptor, &buffer, buffer.count)
            if count > 0 { return Data(buffer[0..<count]) }
            if count < 0 && errno == EINTR { continue }
            return Data()
        }
    }
}
