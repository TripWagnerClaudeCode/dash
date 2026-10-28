import AppKit
import Combine
import SwiftUI

/// What the history sidebar needs to know about a saved chat, plus the settings it runs with.
struct ChatMeta: Codable, Identifiable, Equatable {
    var id = UUID()
    var title = "New chat"
    var titleIsCustom = false
    var createdAt = Date()
    var updatedAt = Date()
    /// The Claude Code session that holds this chat's context. A chat that has run at least one
    /// turn is continued with `--resume`, so quitting Dash or stopping an answer loses nothing.
    var sessionID = UUID().uuidString
    var sessionStarted = false
    /// nil follows the model chosen in Settings.
    var modelID: String?
    var effort = "medium"
    /// "default" (ask), "acceptEdits" or "plan".
    var permissionMode = "default"
    var skillName: String?
    /// Off the record: the hub never summarizes this chat into Dash's memory.
    var offRecord = false
}

extension ChatMeta {
    enum CodingKeys: String, CodingKey {
        case id, title, titleIsCustom, createdAt, updatedAt, sessionID, sessionStarted, modelID, effort
        case permissionMode, skillName, offRecord
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        id = try c.decode(UUID.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? title
        titleIsCustom = try c.decodeIfPresent(Bool.self, forKey: .titleIsCustom) ?? false
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? createdAt
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
        sessionID = try c.decodeIfPresent(String.self, forKey: .sessionID) ?? sessionID
        sessionStarted = try c.decodeIfPresent(Bool.self, forKey: .sessionStarted) ?? false
        modelID = try c.decodeIfPresent(String.self, forKey: .modelID)
        effort = try c.decodeIfPresent(String.self, forKey: .effort) ?? effort
        permissionMode = try c.decodeIfPresent(String.self, forKey: .permissionMode) ?? permissionMode
        skillName = try c.decodeIfPresent(String.self, forKey: .skillName)
        offRecord = try c.decodeIfPresent(Bool.self, forKey: .offRecord) ?? false
    }
}

private struct StoredChat: Codable {
    var meta: ChatMeta
    var turns: [Conversation.Turn]
}

/// Chats live as one JSON file each in Application Support/Dash/chats.
private enum ChatStorage {
    static let directory: URL = {
        let url = Personal.supportDir.appendingPathComponent("chats", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private static func url(_ id: UUID) -> URL { directory.appendingPathComponent("\(id.uuidString).json") }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    static func load(_ id: UUID) -> StoredChat? {
        guard let data = try? Data(contentsOf: url(id)) else { return nil }
        return try? decoder.decode(StoredChat.self, from: data)
    }

    /// A small file of every chat's metadata, so launch doesn't have to decode every transcript.
    private static var indexURL: URL { directory.appendingPathComponent("index.json") }

    static func loadIndex() -> [ChatMeta]? {
        guard let data = try? Data(contentsOf: indexURL) else { return nil }
        return try? decoder.decode([ChatMeta].self, from: data)
    }

    static func saveIndex(_ metas: [ChatMeta]) {
        if let data = try? encoder.encode(metas) { try? data.write(to: indexURL, options: .atomic) }
    }

    static func exists(_ id: UUID) -> Bool { FileManager.default.fileExists(atPath: url(id).path) }

    static func loadAll() -> [StoredChat] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" && $0.lastPathComponent != "index.json" }
            .compactMap { try? Data(contentsOf: $0) }
            .compactMap { try? decoder.decode(StoredChat.self, from: $0) }
    }

    static func save(_ chat: StoredChat) {
        if let data = try? encoder.encode(chat) { try? data.write(to: url(chat.meta.id), options: .atomic) }
    }

    static func delete(_ id: UUID) {
        try? FileManager.default.removeItem(at: url(id))
    }
}

/// The console chat: jarvis tools, Claude Code's own file/shell/web tools, ABOUT_ME + memory, an
/// optional skill, saved history, and a message queue. One instance drives the Chat page; it
/// switches between saved chats rather than holding several at once.
@MainActor
final class ChatConversation: Conversation {
    struct QueuedMessage: Identifiable {
        let id = UUID()
        let text: String
        let attachments: [ChatAttachment]
        /// The hub's id for a message queued there.
        var hubID: String?
    }

    @Published private(set) var chats: [ChatMeta] = []
    @Published private(set) var meta = ChatMeta()
    @Published private(set) var skill: Skill?
    @Published private(set) var queue: [QueuedMessage] = []
    /// Files and images waiting to go with the next message.
    @Published var attachments: [ChatAttachment] = []
    /// Gets back the text of a message the hub didn't take, so the console can put it back in the box.
    var returnUnsent: ((String) -> Void)?

    /// A setting changed mid-answer; the session restarts (with `--resume`) after this turn.
    private var respawnAfterTurn = false
    /// Once this Mac is paired with the Dash hub, chats run there (hub/src/chats.ts) and this class only
    /// shows them and passes on what the user does: the same chats, live, on the phone and here.
    private(set) var hub: HubClient?
    private var hubWatch: AnyCancellable?
    var usesHub: Bool { hub?.isPaired == true }

    override init() {
        super.init()
        // The index is enough for the sidebar; only the newest chat is read in full. A missing or
        // unreadable index (first launch of this version) is rebuilt from the chat files.
        var metas = (ChatStorage.loadIndex() ?? ChatStorage.loadAll().map(\.meta)).filter { ChatStorage.exists($0.id) }
        metas.sort { $0.updatedAt > $1.updatedAt }
        chats = metas
        ChatStorage.saveIndex(metas)
        if let latest = metas.first, let stored = ChatStorage.load(latest.id) { open(stored) }
    }

    override var isResumable: Bool { true }

    override var model: ClaudeModel {
        meta.modelID.map(ClaudeModel.find) ?? super.model
    }

    var needsAttention: Bool { !approvals.isEmpty }

    // MARK: Claude Code session

    override func makeClaude(effort: String) throws -> ClaudeSession {
        var dirs = [Personal.supportDir.path, Personal.outputDir.path]
        if let skill { dirs.append(skill.directory.path) }
        try? FileManager.default.createDirectory(at: Personal.outputDir, withIntermediateDirectories: true)
        var profile = ClaudeProfile.console(addDirs: dirs)
        if meta.permissionMode != "default" { profile.permissionMode = meta.permissionMode }
        // A chat that hasn't completed a turn has nothing to resume; give it a fresh session ID
        // each time, since a half-started one may already be taken.
        if !meta.sessionStarted { meta.sessionID = UUID().uuidString }
        return try ClaudeSession(model: model, effort: effort, system: Personal.consoleSystem(skill: skill),
                                 profile: profile, sessionID: meta.sessionID, resume: meta.sessionStarted)
    }

    /// Memory and to-do list edits, and new files saved into ~/Documents/Dash, don't need a card.
    override func autoApproves(_ request: PermissionRequest) -> Bool {
        guard ["Edit", "Write"].contains(request.toolName),
              let path = request.input["file_path"] as? String
        else { return false }
        let target = URL(fileURLWithPath: path).standardizedFileURL.path
        if [Personal.memoryURL, Personal.todoURL].contains(where: { target == $0.standardizedFileURL.path }) { return true }
        return request.toolName == "Write"
            && target.hasPrefix(Personal.outputDir.standardizedFileURL.path + "/")
            && !FileManager.default.fileExists(atPath: target)
    }

    override func turnDidFinish(_ turn: Turn) {
        // The session now exists in Claude Code, so later spawns resume it. A turn that failed
        // outright may never have created it.
        // A turn that was killed before Claude Code answered (Stop pressed instantly, a crash) may
        // never have created it, so only a live process or a finished turn counts.
        if !turn.isError && (!turn.stopped || claude != nil) { meta.sessionStarted = true }
        persist()
        if respawnAfterTurn {
            respawnAfterTurn = false
            resetClaude()
        }
        if !queue.isEmpty {
            let next = queue.removeFirst()
            dispatch(next.text, next.attachments)
        }
    }

    override func sendDidFail(_ error: Error) {
        // Claude Code lost the session (its transcript was deleted, say). Start a new one; the
        // visible history stays, but the model won't remember it.
        if meta.sessionStarted, error.localizedDescription.localizedCaseInsensitiveContains("no conversation found") {
            meta.sessionStarted = false
            notice = "Claude Code no longer has this chat's earlier context, so it will continue as a fresh session."
        }
    }

    override func stop() {
        if usesHub { return hubCall("chat.stop") }
        queue.removeAll()
        super.stop()
    }

    override func decide(_ approval: Approval, allow: Bool, always: Bool = false) {
        guard usesHub else { return super.decide(approval, allow: allow, always: always) }
        approvals.removeAll { $0.id == approval.id }
        hubCall("chat.decide", ["request": approval.request.id, "allow": allow, "always": always])
    }

    // MARK: Sending

    /// Sends the message, or queues it if Claude is still answering. Returns false if there was
    /// nothing to send, so the caller keeps the draft.
    @discardableResult
    func ask(_ question: String) -> Bool {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = attachments
        guard !text.isEmpty || !files.isEmpty else { return false }
        if usesHub { return hubSend(text, files) }
        attachments = []
        if isBusy {
            queue.append(QueuedMessage(text: text, attachments: files))
        } else {
            dispatch(text, files)
        }
        return true
    }

    private func dispatch(_ text: String, _ files: [ChatAttachment]) {
        // The system prompt is fixed when the session starts, so give the clock with each message.
        var content: [[String: Any]] = [["type": "text", "text": "(It is now \(Personal.now).)"]]
        for file in files { content += file.blocks }
        content.append(["type": "text", "text": text.isEmpty ? "(See the attached.)" : text])
        send(content, display: Turn(role: .user, text: text, attachments: files.map(\.name)), effort: meta.effort)
        persist()
    }

    /// Asks the same question again, as a new message (Claude Code can't rewind a session).
    func retry(afterAssistant turnID: UUID) {
        if usesHub { return hubCall("chat.retry", ["turn": turnID.uuidString]) }
        guard !isBusy, let index = turns.firstIndex(where: { $0.id == turnID }),
              let question = turns[..<index].last(where: { $0.role == .user })
        else { return }
        // Send just the text: the composer's staged attachments aren't part of the original message,
        // and the original's files weren't kept.
        dispatch(question.text, [])
        if !question.attachments.isEmpty {
            notice = "Asked again without the attached files (\(question.attachments.joined(separator: ", "))). Attach them again if they matter."
        }
    }

    /// Closes the live Claude Code process (used by the self-test, which leaves nothing behind).
    func close() {
        resetClaude()
    }

    func removeQueued(_ id: UUID) {
        if usesHub, let hubID = queue.first(where: { $0.id == id })?.hubID { return hubCall("chat.unqueue", ["queued": hubID]) }
        queue.removeAll { $0.id == id }
    }

    // MARK: History

    func newChat(skill: Skill? = nil) {
        guard !isBusy else {
            notice = "Wait for the current answer to finish (or stop it) before starting another chat."
            return
        }
        persist()
        generation += 1
        resetClaude()
        turns = []
        notice = nil
        queue = []
        attachments = []
        meta = ChatMeta()
        self.skill = skill
        meta.skillName = skill?.name
    }

    func select(_ id: UUID) {
        guard id != meta.id else { return }
        guard !isBusy else {
            notice = "Wait for the current answer to finish (or stop it) before switching chats."
            return
        }
        if usesHub { return hubOpen(id) }
        persist()
        guard let stored = ChatStorage.load(id) else { return }
        open(stored)
    }

    func rename(_ id: UUID, to title: String) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        if usesHub {
            if id == meta.id { meta.title = title }
            return hubCall("chat.rename", ["chat": id.uuidString, "title": title])
        }
        if id == meta.id {
            meta.title = title
            meta.titleIsCustom = true
            persist()
        } else if var stored = ChatStorage.load(id) {
            stored.meta.title = title
            stored.meta.titleIsCustom = true
            ChatStorage.save(stored)
            if let index = chats.firstIndex(where: { $0.id == id }) { chats[index] = stored.meta }
            ChatStorage.saveIndex(chats)
        }
    }

    func delete(_ id: UUID) {
        if usesHub { return hubDelete(id) }
        if id == meta.id {
            guard !isBusy else { return }
            ChatStorage.delete(id)
            chats.removeAll { $0.id == id }
            ChatStorage.saveIndex(chats)
            generation += 1
            resetClaude()
            queue = []
            attachments = []
            if let next = chats.first.flatMap({ ChatStorage.load($0.id) }) {
                open(next)
            } else {
                turns = []
                meta = ChatMeta()
                skill = nil
            }
        } else {
            ChatStorage.delete(id)
            chats.removeAll { $0.id == id }
            ChatStorage.saveIndex(chats)
        }
    }

    private func open(_ stored: StoredChat) {
        generation += 1
        resetClaude()
        meta = stored.meta
        turns = stored.turns
        skill = stored.meta.skillName.flatMap(Skill.load)
        notice = nil
        queue = []
        attachments = []
    }

    private func persist() {
        guard !usesHub, !turns.isEmpty else { return }
        meta.updatedAt = Date()
        if !meta.titleIsCustom, let first = turns.first(where: { $0.role == .user }) {
            meta.title = Self.title(from: first)
        }
        // Tool output can be huge; the transcript keeps the start of it.
        var saved = turns
        for t in saved.indices {
            for c in saved[t].tools.indices where saved[t].tools[c].output.count > 8_000 {
                saved[t].tools[c].output = String(saved[t].tools[c].output.prefix(8_000)) + "\n… (saved copy truncated)"
            }
        }
        ChatStorage.save(StoredChat(meta: meta, turns: saved))
        if let index = chats.firstIndex(where: { $0.id == meta.id }) { chats[index] = meta } else { chats.insert(meta, at: 0) }
        chats.sort { $0.updatedAt > $1.updatedAt }
        ChatStorage.saveIndex(chats)
    }

    private static func title(from turn: Turn) -> String {
        let source = turn.text.isEmpty ? (turn.attachments.first ?? "New chat") : turn.text
        let line = source.split(whereSeparator: \.isNewline).first.map(String.init) ?? source
        return line.count > 48 ? String(line.prefix(48)).trimmingCharacters(in: .whitespaces) + "…" : line
    }

    // MARK: The hub

    func useHub(_ hub: HubClient) {
        self.hub = hub
        hub.on("chats") { [weak self] data in self?.applyIndex(data) }
        hub.on("chat") { [weak self] data in self?.applyLive(data) }
        // The last chat opened here, saved, so Chat shows it straight away and while the hub is offline.
        if usesHub, let saved = try? Data(contentsOf: Self.openChatCache),
           let data = try? JSONSerialization.jsonObject(with: saved) as? [String: Any] {
            applyFull(data)
        }
        hubWatch = hub.$state.sink { [weak self] state in
            guard state == .online else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.syncFromHub() } }
        }
    }

    private static let openChatCache = HubClient.cacheDir.appendingPathComponent("chat-open.json")

    /// On (re)connecting: fetch the list and catch up on the open chat, unless it's a new one not sent yet.
    private func syncFromHub() {
        guard let hub, usesHub else { return }
        Task {
            if let list = try? await hub.request("chat.list") { applyIndex(list) }
            if !turns.isEmpty || chats.contains(where: { $0.id == meta.id }) {
                hubOpen(meta.id)
            } else if turns.isEmpty, let latest = chats.first, meta.skillName == nil, !isBusy {
                hubOpen(latest.id)
            }
        }
    }

    private func hubSend(_ text: String, _ files: [ChatAttachment]) -> Bool {
        guard let hub, hub.isOnline else {
            notice = "\(hub?.offlineMessage ?? "The Dash hub is offline.") Your message is still in the box."
            return false
        }
        attachments = []
        // Images and PDFs travel inline; other files are named by path, which the hub has too (it syncs
        // Documents, Desktop and Downloads) under its own home folder.
        let home = Personal.home.path
        let blocks = files.flatMap { file -> [[String: Any]] in
            guard file.kind == .file else { return file.blocks }
            let path = (file.url?.path ?? file.name).replacingOccurrences(of: home, with: "~")
            return [["type": "text", "text": "[Attached file: \(path)]"]]
        }
        var settings: [String: Any] = ["modelID": meta.modelID ?? model.id, "effort": meta.effort,
                                       "permissionMode": meta.permissionMode]
        if let skill = meta.skillName { settings["skillName"] = skill }
        if meta.offRecord { settings["offRecord"] = true }
        hubCall("chat.send", ["text": text, "blocks": blocks, "attachments": files.map(\.name), "settings": settings]) { [weak self] in
            // The box was cleared when this went out; put the message and its files back.
            guard let self else { return }
            if attachments.isEmpty { attachments = files }
            returnUnsent?(text)
            notice = "\(notice ?? "The hub didn't take the message.") Your message is back in the box."
        }
        return true
    }

    /// Sends a request about the open chat; a refusal shows as the chat's notice, then `failed` runs.
    private func hubCall(_ type: String, _ params: [String: Any] = [:], failed: (() -> Void)? = nil) {
        guard let hub else { return }
        var params = params
        if params["chat"] == nil { params["chat"] = meta.id.uuidString }
        Task {
            do {
                _ = try await hub.request(type, params)
            } catch {
                notice = error.localizedDescription
                failed?()
            }
        }
    }

    private func hubOpen(_ id: UUID) {
        guard let hub else { return }
        Task {
            do {
                let data = try await hub.request("chat.open", ["chat": id.uuidString])
                applyFull(data)
            } catch let error as HubClient.HubError where error.fromHub && id == meta.id {
                // The open chat was deleted elsewhere (on the phone, say): show the newest one instead.
                if let next = chats.first(where: { $0.id != id }) { hubOpen(next.id) } else { showEmptyChat() }
            } catch {
                notice = error.localizedDescription
            }
        }
    }

    private func hubDelete(_ id: UUID) {
        guard let hub else { return }
        Task {
            do {
                let list = try await hub.request("chat.delete", ["chat": id.uuidString])
                applyIndex(list)
                if id == meta.id {
                    if let next = chats.first { hubOpen(next.id) } else { showEmptyChat() }
                }
            } catch {
                notice = error.localizedDescription
            }
        }
    }

    private func showEmptyChat() {
        meta = ChatMeta()
        turns = []
        skill = nil
        queue = []
        approvals = []
        status = .idle
    }

    private func applyIndex(_ data: [String: Any]) {
        guard usesHub, let metas = HubJSON.decode([ChatMeta].self, data["chats"]) else { return }
        chats = metas
    }

    /// A whole chat (`chat.open`): its transcript plus the live state.
    private func applyFull(_ data: [String: Any]) {
        guard data["turns"] is [Any] else { return }
        if let meta = HubJSON.decode(ChatMeta.self, data["meta"]), meta.id != self.meta.id {
            notice = nil
        }
        applyHubTurns(data)
        applyState(data)
        if JSONSerialization.isValidJSONObject(data), let json = try? JSONSerialization.data(withJSONObject: data) {
            try? FileManager.default.createDirectory(at: HubClient.cacheDir, withIntermediateDirectories: true)
            try? json.write(to: Self.openChatCache, options: .atomic)
        }
    }

    /// A `chat` event: the last two turns and the live state. Events for other chats only update the list.
    private func applyLive(_ data: [String: Any]) {
        guard usesHub, let id = (data["id"] as? String).flatMap(UUID.init(uuidString:)) else { return }
        if let meta = HubJSON.decode(ChatMeta.self, data["meta"]), let index = chats.firstIndex(where: { $0.id == id }) {
            chats[index] = meta
        }
        guard id == meta.id else { return }
        guard applyHubTurns(data) else { return hubOpen(id) }
        applyState(data)
    }

    private func applyState(_ data: [String: Any]) {
        if let meta = HubJSON.decode(ChatMeta.self, data["meta"]) {
            self.meta = meta
            if skill?.name != meta.skillName { skill = meta.skillName.flatMap(Skill.load) }
        }
        applyHubState(data)
        queue = (data["queue"] as? [[String: Any]] ?? []).map { entry in
            QueuedMessage(text: entry["text"] as? String ?? "", attachments: [], hubID: entry["id"] as? String)
        }
    }

    // MARK: Per-chat settings

    func setModel(_ id: String?) {
        meta.modelID = id
        settingsChanged()
    }

    func setEffort(_ effort: String) {
        meta.effort = effort
        settingsChanged()
    }

    func setPermissionMode(_ mode: String) {
        meta.permissionMode = mode
        settingsChanged()
    }

    func setOffRecord(_ on: Bool) {
        meta.offRecord = on
        settingsChanged()
    }

    /// Adds or removes a skill without losing the conversation: the session restarts with the new
    /// system prompt and resumes where it left off.
    func load(skill: Skill?) {
        guard !isBusy else { return }
        self.skill = skill
        meta.skillName = skill?.name
        settingsChanged()
    }

    private func settingsChanged() {
        if usesHub {
            // A chat the hub hasn't seen yet takes its settings with its first message.
            guard !turns.isEmpty else { return }
            var settings: [String: Any] = ["modelID": meta.modelID ?? NSNull(), "effort": meta.effort,
                                           "permissionMode": meta.permissionMode]
            settings["skillName"] = meta.skillName ?? NSNull()
            settings["offRecord"] = meta.offRecord
            return hubCall("chat.settings", ["settings": settings])
        }
        persist()
        if isBusy {
            respawnAfterTurn = true
        } else if claude != nil {
            resetClaude()
        }
    }
}
