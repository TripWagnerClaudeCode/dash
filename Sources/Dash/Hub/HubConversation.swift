import AppKit
import Foundation

/// Showing a chat that runs on the Dash hub (hub/src/chats.ts) in a `Conversation`: the console chat
/// and the Portfolio advisor both use this. The hub sends the same JSON shapes as the Codable types here.
extension Conversation {
    /// A whole transcript (`turns`, from `chat.open`) or a `chat` event's last two turns (`tail`).
    /// Returns false when a tail doesn't line up with what's on screen (something was missed), so the
    /// caller should fetch the whole chat.
    @discardableResult
    func applyHubTurns(_ data: [String: Any]) -> Bool {
        if let all = HubJSON.decode([Turn].self, data["turns"]) {
            turns = all
            return true
        }
        guard let tail = HubJSON.decode([Turn].self, data["tail"]) else { return true }
        let count = data["count"] as? Int ?? turns.count
        let keep = count - tail.count
        guard keep >= 0, keep <= turns.count else { return false }
        turns = Array(turns.prefix(keep)) + tail
        return true
    }

    /// Busy or not, Stop pressed, the notice, and Approve/Deny cards.
    func applyHubState(_ data: [String: Any]) {
        status = switch data["status"] as? String {
        case "thinking": .thinking
        case "streaming": .streaming
        default: .idle
        }
        stopping = data["stopping"] as? Bool ?? false
        // The hub sends `notice: null` once its notice no longer applies.
        if data.keys.contains("notice") {
            let notice = data["notice"] as? String
            if let notice, notice != hubNotice {
                self.notice = notice
            } else if notice == nil, hubNotice != nil, self.notice == hubNotice {
                self.notice = nil
            }
            hubNotice = notice
        }
        let previous = approvals.count
        approvals = (data["approvals"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let id = entry["id"] as? String, let tool = entry["toolName"] as? String else { return nil }
            // "Always allow" is offered when the hub has a narrow rule for it; the rule itself stays there.
            let request = PermissionRequest(id: id, toolName: tool, displayName: entry["displayName"] as? String ?? tool,
                                            input: entry["input"] as? [String: Any] ?? [:],
                                            suggestions: entry["canAlways"] as? Bool == true ? [["fromHub": true]] : [])
            return Approval(request: request)
        }
        // A card nobody sees leaves Claude waiting; bounce the Dock icon if Dash is in the background.
        if approvals.count > previous, !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
    }
}

enum HubJSON {
    /// Decodes the hub's JSON into Codable types; its dates may carry milliseconds.
    static func decode<T: Decodable>(_ type: T.Type, _ value: Any?) -> T? {
        guard let value, JSONSerialization.isValidJSONObject(value) || value is [Any],
              let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let string = try decoder.singleValueContainer().decode(String.self)
            guard let date = HubClient.date(string) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad date \(string)"))
            }
            return date
        }
        return try? decoder.decode(T.self, from: data)
    }
}
