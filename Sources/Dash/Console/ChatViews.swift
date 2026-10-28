import AppKit
import SwiftUI

// MARK: Page

struct ChatPage: View {
    @EnvironmentObject var console: Console

    var body: some View {
        ChatBody(chat: console.chat, draft: $console.chatDraft)
    }
}

private struct ChatBody: View {
    @ObservedObject var chat: ChatConversation
    @Binding var draft: String
    @AppStorage("chatHistoryShown") private var showHistory = true
    @State private var width: CGFloat = 900

    /// The history list sits beside the chat only when there's room; otherwise it's a popover.
    private var historyFits: Bool { width >= 820 }

    var body: some View {
        HStack(spacing: 0) {
            if showHistory && historyFits {
                ChatHistoryList(chat: chat)
                    .frame(width: 210)
                Divider()
            }
            VStack(spacing: 0) {
                ChatToolbar(chat: chat, showHistory: $showHistory, historyFits: historyFits)
                ChatScroll(chat: chat, draft: $draft)
                ChatComposer(chat: chat, draft: $draft)
            }
        }
        .background(GeometryReader { proxy in
            Color.clear.onChange(of: proxy.size.width, initial: true) { _, newWidth in width = newWidth }
        })
    }
}

// MARK: Toolbar

private struct ChatToolbar: View {
    @ObservedObject var chat: ChatConversation
    @Binding var showHistory: Bool
    let historyFits: Bool
    @State private var historyPopover = false

    var body: some View {
        HStack(spacing: 10) {
            Button {
                if historyFits { showHistory.toggle() } else { historyPopover.toggle() }
            } label: {
                Image(systemName: "sidebar.left")
            }
            .help("Chat history")
            .popover(isPresented: $historyPopover, arrowEdge: .bottom) {
                ChatHistoryList(chat: chat, onPick: { historyPopover = false }).frame(width: 260, height: 360)
            }

            Text(chat.turns.isEmpty ? "New chat" : chat.meta.title)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
            if let skill = chat.skill {
                HStack(spacing: 4) {
                    Label(skill.name, systemImage: "wand.and.stars")
                        .font(.system(size: 11.5, weight: .medium))
                        .lineLimit(1)
                    Button { chat.load(skill: nil) } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless)
                        .help("Unload this skill (the chat continues)")
                        .disabled(chat.isBusy)
                }
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(.tint.opacity(0.15), in: Capsule())
            }
            Spacer(minLength: 8)
            ChatSettingsMenu(chat: chat)
            Button { chat.copyLastAnswer() } label: { Image(systemName: "doc.on.doc") }
                .help("Copy last answer")
                .disabled(chat.turns.isEmpty)
            Button { chat.newChat() } label: { Label("New chat", systemImage: "square.and.pencil") }
                .labelStyle(.titleAndIcon)
                .disabled(chat.isBusy || chat.turns.isEmpty)
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
    }
}

private struct ChatSettingsMenu: View {
    @ObservedObject var chat: ChatConversation

    var body: some View {
        Menu {
            Section("Model") {
                Picker("Model", selection: Binding(
                    get: { chat.meta.modelID ?? "" },
                    set: { chat.setModel($0.isEmpty ? nil : $0) }
                )) {
                    Text("Same as Settings").tag("")
                    ForEach(ClaudeModel.all) { Text("\($0.name) · \($0.blurb)").tag($0.id) }
                }
                .pickerStyle(.inline).labelsHidden()
            }
            if chat.model.supportsEffort {
                Section("Effort") {
                    Picker("Effort", selection: Binding(get: { chat.meta.effort }, set: { chat.setEffort($0) })) {
                        Text("Low (fastest)").tag("low")
                        Text("Medium").tag("medium")
                        Text("High (most thorough)").tag("high")
                    }
                    .pickerStyle(.inline).labelsHidden()
                }
            }
            Section("Permissions") {
                Picker("Permissions", selection: Binding(
                    get: { chat.meta.permissionMode },
                    set: { chat.setPermissionMode($0) }
                )) {
                    Text("Ask before changes").tag("default")
                    Text("Accept file edits").tag("acceptEdits")
                    Text("Plan only (no changes)").tag("plan")
                }
                .pickerStyle(.inline).labelsHidden()
            }
            if chat.usesHub {
                Section("Memory") {
                    Toggle("Off the record", isOn: Binding(get: { chat.meta.offRecord }, set: { chat.setOffRecord($0) }))
                }
            }
        } label: {
            Label(chat.meta.offRecord ? "\(chat.model.name) · off the record" : chat.model.name,
                  systemImage: chat.meta.offRecord ? "eye.slash" : "slider.horizontal.3")
                .font(.system(size: 12))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Model, effort and permissions for this chat")
    }
}

// MARK: History

private struct ChatHistoryList: View {
    @ObservedObject var chat: ChatConversation
    var onPick: () -> Void = {}
    @State private var renaming: ChatMeta?
    @State private var renameText = ""
    @State private var deleting: ChatMeta?

    var body: some View {
        VStack(spacing: 0) {
            Button {
                chat.newChat()
                onPick()
            } label: {
                Label("New chat", systemImage: "square.and.pencil")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .disabled(chat.isBusy || chat.turns.isEmpty)

            Divider()

            if chat.chats.isEmpty {
                Text("Your chats show up here and are kept between launches.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(14)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(chat.chats) { item in
                            row(item)
                        }
                    }
                    .padding(8)
                }
            }
        }
        .background(.background.secondary.opacity(0.5))
        .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $renameText)
            Button("Rename") {
                if let renaming { chat.rename(renaming.id, to: renameText) }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Delete “\(deleting?.title ?? "")”?", isPresented: Binding(
            get: { deleting != nil }, set: { if !$0 { deleting = nil } }
        )) {
            Button("Delete chat", role: .destructive) {
                if let deleting { chat.delete(deleting.id) }
                deleting = nil
            }
        } message: {
            Text("This removes it from Dash. It can't be undone.")
        }
    }

    private func row(_ item: ChatMeta) -> some View {
        let selected = item.id == chat.meta.id
        return Button {
            chat.select(item.id)
            onPick()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.system(size: 12.5, weight: selected ? .semibold : .regular)).lineLimit(1)
                Text(item.updatedAt.formatted(.relative(presentation: .named)))
                    .font(.system(size: 10.5)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? AnyShapeStyle(.tint.opacity(0.16)) : AnyShapeStyle(.clear),
                        in: RoundedRectangle(cornerRadius: 7))
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Rename…") {
                renameText = item.title
                renaming = item
            }
            Button("Delete…", role: .destructive) { deleting = item }
                .disabled(chat.isBusy && selected)
        }
    }
}

// MARK: Transcript

private struct ChatScroll: View {
    @ObservedObject var chat: ChatConversation
    @Binding var draft: String
    /// Whether the end of the conversation is in view; streaming only follows while it is.
    @State private var atBottom = true
    @State private var scrollTracker = ScrollTracker()

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if chat.turns.isEmpty { emptyState }
                    if let notice = chat.notice {
                        Text(notice).font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    ForEach(chat.turns) { turn in
                        ChatTurnView(
                            turn: turn,
                            isLive: chat.isBusy && turn.id == chat.turns.last?.id,
                            onRetry: { chat.retry(afterAssistant: turn.id) },
                            onEdit: { draft = turn.text }
                        )
                        .equatable()
                    }
                    ForEach(chat.approvals) { approval in
                        ApprovalCard(approval: approval,
                                     always: approval.request.suggestions.isEmpty ? nil : {
                                         chat.decide(approval, allow: true, always: true)
                                     }) { chat.decide(approval, allow: $0) }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear {
                            // Streamed text also pushes the end out of view just before we scroll to
                            // it. Only count it as "scrolled up" if the reader was actually scrolling.
                            if scrollTracker.userScrolledRecently { atBottom = false }
                        }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .frame(maxWidth: 780, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            // An opened chat starts at its latest message; the welcome screen stays at the top.
            .defaultScrollAnchor(chat.turns.isEmpty ? .top : .bottom)
            .overlay(alignment: .bottom) {
                if !atBottom && (chat.isBusy || !chat.approvals.isEmpty) {
                    Button {
                        atBottom = true
                        proxy.scrollTo("bottom", anchor: .bottom)
                    } label: {
                        Label(chat.approvals.isEmpty ? "Jump to latest" : "Needs your approval",
                              systemImage: "arrow.down")
                            .font(.system(size: 12, weight: .medium))
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(.regularMaterial, in: Capsule())
                            .overlay(Capsule().strokeBorder(.separator))
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 10)
                }
            }
            .onChange(of: chat.turns.last?.text) { followIfPinned(proxy) }
            .onChange(of: chat.turns.last?.tools.count) { followIfPinned(proxy) }
            .onChange(of: chat.approvals.count) { followIfPinned(proxy, force: true) }
            .onChange(of: chat.turns.count) {
                // A message you just sent (or a chat you just opened) always lands at the bottom.
                atBottom = true
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onChange(of: chat.meta.id) {
                atBottom = true
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear { scrollTracker.start() }
            .onDisappear { scrollTracker.stop() }
        }
    }

    private func followIfPinned(_ proxy: ScrollViewProxy, force: Bool = false) {
        if atBottom || force { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(chat.skill == nil ? "What can I help with?" : "\(chat.skill!.name) is loaded")
                    .font(.system(size: 20, weight: .semibold))
                Text(chat.skill == nil
                     ? "Dash can read your calendar, inbox, to-dos, files and the web, run commands, and edit files. It asks before it sends an email, changes your calendar, runs anything that changes your Mac, or edits files outside ~/Documents/Dash. Type / to load a skill, paste or drop in images and files, and say “remember…” to save something for later."
                     : "Tell it what you're working on. Files it makes go in ~/Documents/Dash.")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if chat.skill == nil {
                FlowRow(spacing: 6) {
                    starter("What's due this week?", send: true)
                    starter("Draft an email to ", send: false)
                    starter("Add to my calendar: ", send: false)
                    starter("Search the web for ", send: false)
                    starter("Remember that ", send: false)
                }
            }
        }
        .padding(.top, 28)
    }

    private func starter(_ text: String, send: Bool) -> some View {
        Button(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ":", with: "")) {
            if send { chat.ask(text) } else { draft = text }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }
}

/// Notes when the user last used the scroll wheel or trackpad in this app, so the transcript can
/// tell "the reader scrolled up" from "new text pushed the end out of view".
@MainActor
private final class ScrollTracker {
    private var monitor: Any?
    private var last = Date.distantPast

    var userScrolledRecently: Bool { Date().timeIntervalSince(last) < 0.6 }

    func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            MainActor.assumeIsolated { self?.last = Date() }
            return event
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}

// MARK: Turns

/// Equatable so finished messages aren't laid out again while a newer one streams.
private struct ChatTurnView: View, Equatable {
    let turn: Conversation.Turn
    let isLive: Bool
    let onRetry: () -> Void
    let onEdit: () -> Void
    @State private var hovering = false

    static func == (lhs: ChatTurnView, rhs: ChatTurnView) -> Bool {
        lhs.turn == rhs.turn && lhs.isLive == rhs.isLive
    }

    var body: some View {
        switch turn.role {
        case .user: user
        case .assistant: assistant
        }
    }

    private var user: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !turn.attachments.isEmpty {
                FlowRow(spacing: 4) {
                    ForEach(turn.attachments, id: \.self) { name in
                        Label(name, systemImage: "paperclip")
                            .font(.system(size: 11)).lineLimit(1)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(.quaternary.opacity(0.6), in: Capsule())
                    }
                }
            }
            if !turn.text.isEmpty {
                Text(turn.text)
                    .font(.system(size: 13.5))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 12))
            }
            actions([("doc.on.doc", "Copy", { copy(turn.text) }), ("pencil", "Edit as a new message", onEdit)])
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .onHover { hovering = $0 }
    }

    private var assistant: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !turn.thinking.isEmpty {
                DisclosureGroup {
                    Text(turn.thinking)
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 4)
                } label: {
                    Label(isLive && turn.text.isEmpty ? "Thinking…" : "Thought", systemImage: "brain")
                        .font(.system(size: 11.5, weight: .medium)).foregroundStyle(.secondary)
                }
            }
            ForEach(turn.tools) { ToolCardView(tool: $0) }
            if turn.text.isEmpty && isLive {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(turn.tools.contains { !$0.done } ? "Working…" : "Thinking…")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
            } else if !turn.text.isEmpty {
                if turn.isError {
                    Text(turn.text).font(.system(size: 13.5)).foregroundStyle(.red).textSelection(.enabled)
                } else {
                    MarkdownView(text: turn.text).equatable()
                }
            }
            if turn.stopped {
                Label("Stopped", systemImage: "stop.circle").font(.system(size: 11)).foregroundStyle(.tertiary)
            }
            if !isLive && !turn.text.isEmpty {
                actions([("doc.on.doc", "Copy", { copy(turn.text) }), ("arrow.clockwise", "Ask again", onRetry)])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { hovering = $0 }
    }

    /// Small buttons that appear under a message while the pointer is over it.
    private func actions(_ items: [(icon: String, help: String, action: () -> Void)]) -> some View {
        HStack(spacing: 10) {
            ForEach(items.indices, id: \.self) { index in
                Button(action: items[index].action) { Image(systemName: items[index].icon) }
                    .help(items[index].help)
            }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 11.5))
        .foregroundStyle(.secondary)
        .opacity(hovering ? 1 : 0)
        .frame(height: 16)
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

// MARK: Tool calls

/// One tool call: a line saying what happened, expandable to the command, diff or output.
private struct ToolCardView: View {
    let tool: Conversation.ToolCall
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    if tool.done {
                        Image(systemName: tool.failed ? "xmark.circle.fill" : "checkmark.circle.fill")
                            .foregroundStyle(tool.failed ? AnyShapeStyle(.orange) : AnyShapeStyle(.green))
                    } else {
                        ProgressView().controlSize(.mini).scaleEffect(0.7).frame(width: 12, height: 12)
                    }
                    Text(tool.label).font(.system(size: 12, weight: .medium))
                    Text(tool.summary)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ToolDetailView(name: tool.name, input: tool.input)
                    if !tool.output.isEmpty {
                        Text("OUTPUT").font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
                        ScrollView {
                            Text(tool.output)
                                .font(.system(size: 11.5, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 220)
                    }
                }
                .padding(.horizontal, 10).padding(.bottom, 10)
            }
        }
        .background(.background.secondary.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator.opacity(0.6)))
    }
}

/// The arguments of a tool call, laid out for the tool: a command, a diff, or labeled fields.
/// Shared by the tool cards and the approval card, which must show the whole thing before you approve.
struct ToolDetailView: View {
    let name: String
    let input: [String: Any]
    /// Show every line. The approval card sets this; the compact tool cards clip long content.
    var full = false

    var body: some View {
        switch name {
        case "Bash":
            mono("$ " + (input["command"] as? String ?? ""))
        case "Edit":
            VStack(alignment: .leading, spacing: 6) {
                path
                diff(removed: input["old_string"] as? String ?? "", added: input["new_string"] as? String ?? "")
            }
        case "Write":
            VStack(alignment: .leading, spacing: 6) {
                path
                mono(input["content"] as? String ?? "", lines: full ? .max : 40)
            }
        default:
            fields
        }
    }

    @ViewBuilder private var path: some View {
        if let file = input["file_path"] as? String {
            Text(file).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Tools.fields(input), id: \.key) { field in
                VStack(alignment: .leading, spacing: 1) {
                    Text(field.key.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.system(size: 10, weight: .medium)).foregroundStyle(.tertiary)
                    Text(field.value).font(.system(size: 12)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func mono(_ text: String, lines: Int? = nil) -> some View {
        let lines = lines ?? (full ? .max : 200)
        let shown = text.components(separatedBy: "\n")
        let clipped = shown.count > lines
        return VStack(alignment: .leading, spacing: 2) {
            Text(shown.prefix(lines).joined(separator: "\n"))
                .font(.system(size: 11.5, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if clipped {
                Text("… \(shown.count - lines) more lines").font(.system(size: 11)).foregroundStyle(.tertiary)
            }
        }
        .padding(8)
        .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 6))
    }

    private func diff(removed: String, added: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !removed.isEmpty { block(removed, sign: "−", tint: .red) }
            if !added.isEmpty { block(added, sign: "+", tint: .green) }
        }
    }

    private func block(_ text: String, sign: String, tint: Color) -> some View {
        let lines = text.components(separatedBy: "\n")
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.prefix(full ? lines.count : 60).enumerated()), id: \.offset) { _, line in
                Text("\(sign) \(line)")
                    .font(.system(size: 11.5, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !full && lines.count > 60 {
                Text("… \(lines.count - 60) more lines").font(.system(size: 11)).foregroundStyle(.tertiary)
            }
        }
        .padding(8)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    }
}

extension Tools {
    /// The one-line gist of a call, shown beside its name: the command, file name, query or URL.
    static func summary(name: String, input: [String: Any]) -> String {
        func file(_ key: String) -> String? {
            (input[key] as? String).map { URL(fileURLWithPath: $0).lastPathComponent }
        }
        switch name {
        case "Bash": return (input["command"] as? String)?.components(separatedBy: "\n").first ?? ""
        case "Read", "Edit", "Write", "NotebookEdit": return file("file_path") ?? file("notebook_path") ?? ""
        case "Glob", "Grep": return input["pattern"] as? String ?? ""
        case "WebFetch": return input["url"] as? String ?? ""
        case "WebSearch": return input["query"] as? String ?? ""
        case "Task": return input["description"] as? String ?? ""
        default:
            return (input["query"] as? String) ?? (input["subject"] as? String) ?? (input["title"] as? String) ?? ""
        }
    }
}

// MARK: Composer

private struct ChatComposer: View {
    @ObservedObject var chat: ChatConversation
    @Binding var draft: String
    @State private var height: CGFloat = 22
    @State private var focusToken = 0
    @State private var skills: [(name: String, description: String)] = []
    @State private var pickerIndex = 0
    @State private var dropTargeted = false

    /// Skills matching what's typed after a leading "/", while it's still a single word.
    private var matches: [(name: String, description: String)] {
        guard draft.hasPrefix("/"), !draft.contains(where: \.isWhitespace) else { return [] }
        let query = draft.dropFirst().lowercased()
        let found = query.isEmpty ? skills : skills.filter { $0.name.lowercased().contains(query) }
        return Array(found.prefix(7))
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !chat.attachments.isEmpty
    }

    var body: some View {
        VStack(spacing: 6) {
            if !matches.isEmpty { skillPicker }
            if !chat.queue.isEmpty { queued }
            if !chat.attachments.isEmpty { attachmentRow }

            HStack(alignment: .bottom, spacing: 8) {
                Button(action: attach) { Image(systemName: "paperclip").font(.system(size: 15)) }
                    .buttonStyle(.borderless)
                    .help("Attach files or images (or paste / drop them)")
                    .padding(.bottom, 3)

                ZStack(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(placeholder)
                            .font(.system(size: 13.5)).foregroundStyle(.tertiary)
                            .padding(.top, 2)
                            .allowsHitTesting(false)
                    }
                    ComposerTextView(text: $draft, height: $height, focusToken: focusToken,
                                     onSubmit: submit, onAttach: { chat.attachments += $0 }, onKey: handle)
                        .frame(height: height)
                }

                if chat.isBusy {
                    if canSend {
                        Button(action: submit) { Image(systemName: "text.badge.plus").font(.system(size: 17)) }
                            .buttonStyle(.borderless)
                            .help("Queue this message to send when Claude is done")
                            .padding(.bottom, 1)
                    }
                    Button { chat.stop() } label: {
                        Image(systemName: chat.stopping ? "hourglass.circle.fill" : "stop.circle.fill").font(.system(size: 21))
                    }
                    .buttonStyle(.borderless)
                    .help(chat.stopping ? "Stopping…" : "Stop")
                } else {
                    Button(action: submit) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 21)) }
                        .buttonStyle(.borderless)
                        .disabled(!canSend)
                        .help("Send (Return). Shift-Return adds a line.")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .strokeBorder(dropTargeted ? AnyShapeStyle(.tint) : AnyShapeStyle(.separator)))
        }
        .frame(maxWidth: 780)
        .padding(.horizontal, 18)
        .padding(.bottom, 14)
        .dropDestination(for: URL.self) { urls, _ in
            chat.attachments += urls.compactMap(ChatAttachment.from(url:))
            return !urls.isEmpty
        } isTargeted: { dropTargeted = $0 }
        .onAppear { skills = Skill.all() }
        .onChange(of: draft) { _, new in
            pickerIndex = 0
            if new.hasPrefix("/"), skills.isEmpty { skills = Skill.all() }
        }
        .onChange(of: chat.meta.id) { focusToken += 1 }
    }

    private var placeholder: String {
        if let skill = chat.skill { return "Message \(skill.name)…" }
        return chat.isBusy ? "Type to queue a follow-up…" : "Ask Dash anything…   (/ for skills)"
    }

    private func submit() {
        if matches.indices.contains(pickerIndex), draft.hasPrefix("/") { return choose(matches[pickerIndex].name) }
        guard canSend else { return }
        if chat.ask(draft) { draft = "" }
    }

    private func choose(_ name: String) {
        guard !chat.isBusy else {
            chat.notice = "Wait for the current answer to finish (or stop it) before loading a skill."
            return
        }
        chat.load(skill: Skill.load(name))
        draft = ""
    }

    private func handle(_ key: ComposerKey) -> Bool {
        guard !matches.isEmpty else { return false }
        switch key {
        case .up: pickerIndex = max(0, pickerIndex - 1)
        case .down: pickerIndex = min(matches.count - 1, pickerIndex + 1)
        case .enter, .tab:
            guard matches.indices.contains(pickerIndex) else { return false }
            choose(matches[pickerIndex].name)
        case .escape: draft = ""
        }
        return true
    }

    private func attach() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.message = "Choose files or images to send with your message"
        guard panel.runModal() == .OK else { return }
        chat.attachments += panel.urls.compactMap(ChatAttachment.from(url:))
    }

    private var skillPicker: some View {
        VStack(spacing: 0) {
            ForEach(Array(matches.enumerated()), id: \.offset) { index, skill in
                Button { choose(skill.name) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "wand.and.stars").foregroundStyle(.tint).frame(width: 16)
                        Text(skill.name).font(.system(size: 12.5, weight: .medium))
                        Text(skill.description).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(index == pickerIndex ? AnyShapeStyle(.tint.opacity(0.16)) : AnyShapeStyle(.clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var queued: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(chat.queue) { message in
                HStack(spacing: 6) {
                    Image(systemName: "clock").font(.system(size: 10))
                    Text(message.text.isEmpty ? "(attachments)" : message.text).lineLimit(1)
                    Spacer(minLength: 0)
                    Button { chat.removeQueued(message.id) } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless).help("Remove from queue")
                }
                .font(.system(size: 11.5)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attachmentRow: some View {
        FlowRow(spacing: 6) {
            ForEach(chat.attachments) { file in
                HStack(spacing: 5) {
                    if let thumbnail = file.thumbnail {
                        Image(nsImage: thumbnail).resizable().aspectRatio(contentMode: .fill)
                            .frame(width: 22, height: 22).clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    Text(file.name).lineLimit(1).frame(maxWidth: 160)
                    Button { chat.attachments.removeAll { $0.id == file.id } } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                }
                .font(.system(size: 11.5))
                .padding(.horizontal, 7).padding(.vertical, 4)
                .background(.quaternary.opacity(0.6), in: Capsule())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
