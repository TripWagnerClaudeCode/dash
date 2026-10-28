import SwiftUI

/// Small capsules showing what Claude is doing: "Checking calendar ✓".
struct ToolChips: View {
    let tools: [Conversation.ToolCall]

    var body: some View {
        FlowRow(spacing: 4) {
            ForEach(tools) { tool in
                HStack(spacing: 4) {
                    if tool.done {
                        Image(systemName: tool.failed ? "xmark" : "checkmark")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundStyle(tool.failed ? AnyShapeStyle(.orange) : AnyShapeStyle(.green))
                    } else {
                        ProgressView().controlSize(.mini).scaleEffect(0.7).frame(width: 10, height: 10)
                    }
                    Text(tool.label).font(.system(size: 10.5, weight: .medium))
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(.quaternary.opacity(0.6), in: Capsule())
                .foregroundStyle(.secondary)
            }
        }
    }
}

/// A tool call waiting on the user: what it is, everything it will do, and Approve / Deny. Nothing is
/// cut off: a long email body, command or diff scrolls inside the card, so you see what you approve.
struct ApprovalCard: View {
    let approval: Conversation.Approval
    /// "Always allow" for the rest of this chat; nil when Claude Code offered no rule to remember.
    var always: (() -> Void)?
    let decide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(approval.title, systemImage: "hand.raised.fill")
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(.orange)
            ViewThatFits(in: .vertical) {
                detail
                ScrollView { detail }.frame(height: 300)
            }
            HStack {
                Spacer()
                Button("Deny") { decide(false) }
                if let always {
                    Button("Always allow", action: always)
                        .help("Allow this kind of call without asking again in this chat")
                }
                Button("Approve") { decide(true) }
                    .keyboardShortcut(.defaultAction)
                    .tint(.orange)
            }
            .controlSize(.regular)
        }
        .padding(12)
        .cardSurface(radius: 10, tint: .orange)
    }

    private var detail: some View {
        ToolDetailView(name: approval.request.toolName, input: approval.request.input, full: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The scrolling list of turns, with approval cards pinned after the live turn.
struct ConversationScroll<Empty: View>: View {
    @ObservedObject var conversation: Conversation
    var fontSize: CGFloat = 13.5
    @ViewBuilder var empty: () -> Empty

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if conversation.turns.isEmpty { empty() }
                    if let notice = conversation.notice {
                        Text(notice).font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    ForEach(conversation.turns) { turn in
                        TurnView(turn: turn,
                                 isLive: conversation.isBusy && turn.id == conversation.turns.last?.id,
                                 fontSize: fontSize)
                            .equatable()
                    }
                    ForEach(conversation.approvals) { approval in
                        ApprovalCard(approval: approval) { conversation.decide(approval, allow: $0) }
                    }
                    Color.clear.frame(height: 0).id("bottom")
                }
                .padding(18)
                .frame(maxWidth: DS.chatWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: conversation.turns.last?.text) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: conversation.turns.count) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: conversation.approvals.count) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }
}

/// The message field with send/stop.
struct Composer: View {
    let placeholder: String
    @Binding var draft: String
    let isBusy: Bool
    let send: () -> Void
    let stop: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5))
                .lineLimit(1...8)
                .focused($focused)
                .onSubmit(submit)
            if isBusy {
                Button(action: stop) { Image(systemName: "stop.circle.fill").font(.system(size: 20)) }
                    .buttonStyle(.borderless)
                    .help("Stop")
            } else {
                Button(action: submit) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 20)) }
                    .buttonStyle(.borderless)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("Send (Return)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
        .frame(maxWidth: DS.chatWidth)
        .padding(.horizontal, 18)
        .padding(.bottom, 14)
        .onAppear { focused = true }
    }

    private func submit() {
        guard !isBusy, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        send()
    }
}

/// A titled tile for the Today page.
struct Card<Content: View, Accessory: View>: View {
    let title: String
    let icon: String
    @ViewBuilder var accessory: () -> Accessory
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(title, systemImage: icon)
                    .font(.cardTitle)
                    .foregroundStyle(.secondary)
                Spacer()
                accessory()
            }
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface()
    }
}

extension Card where Accessory == EmptyView {
    init(title: String, icon: String, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, icon: icon, accessory: { EmptyView() }, content: content)
    }
}

/// Shows a Load's loading and failure states, and the content once it's there.
struct LoadView<Value, Content: View>: View {
    let load: Load<Value>
    @ViewBuilder var content: (Value) -> Content

    var body: some View {
        switch load {
        case .idle, .loading:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Loading…").foregroundStyle(.secondary)
            }
            .font(.system(size: 12))
        case .failed(let message):
            Text(message).font(.system(size: 12)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
        case .loaded(let value):
            content(value)
        }
    }
}

/// Lays children out left to right, wrapping onto new lines.
struct FlowRow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, point) in zip(subviews, arrange(width: bounds.width, subviews: subviews).points) {
            subview.place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        var points: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: maxX, height: y + rowHeight), points)
    }
}

// MARK: Adaptive table rows

/// How one cell of a `ColumnRow` is sized.
struct ColumnSpec {
    var width: CGFloat
    /// 0 is the most important column; the highest priorities drop out first when the row is narrow.
    var priority: Int
    /// A flexible column takes whatever width is left once the fixed columns are placed.
    var flexible = false
}

private struct ColumnSpecKey: LayoutValueKey {
    static let defaultValue = ColumnSpec(width: 80, priority: 0)
}

extension View {
    func column(width: CGFloat, priority: Int, flexible: Bool = false) -> some View {
        layoutValue(key: ColumnSpecKey.self, value: ColumnSpec(width: width, priority: priority, flexible: flexible))
    }
}

/// A table row that fits whatever width it's given: columns that don't fit are dropped, lowest
/// priority first, the same way in every row of the table. Unlike an HStack of fixed-width cells
/// it asks for no minimum width, so a wide table can never push the window or the page wider than
/// the space it has.
struct ColumnRow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? idealWidth(subviews)
        let shown = visible(subviews, width: width)
        let frames = widths(subviews, shown: shown, total: width)
        var height: CGFloat = 0
        for index in subviews.indices where shown.contains(index) {
            height = max(height, subviews[index].sizeThatFits(ProposedViewSize(width: frames[index], height: nil)).height)
        }
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let shown = visible(subviews, width: bounds.width)
        let frames = widths(subviews, shown: shown, total: bounds.width)
        var x = bounds.minX
        for index in subviews.indices {
            guard shown.contains(index) else {
                // Off to the side and zero-sized; the row is clipped, so nothing shows.
                subviews[index].place(at: CGPoint(x: bounds.minX - 10_000, y: bounds.minY), anchor: .topLeading,
                                      proposal: ProposedViewSize(width: 0, height: 0))
                continue
            }
            subviews[index].place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading,
                                  proposal: ProposedViewSize(width: frames[index], height: nil))
            x += frames[index] + spacing
        }
    }

    private func spec(_ subview: LayoutSubview) -> ColumnSpec { subview[ColumnSpecKey.self] }

    private func idealWidth(_ subviews: Subviews) -> CGFloat {
        subviews.map { spec($0).width }.reduce(0, +) + spacing * CGFloat(max(0, subviews.count - 1))
    }

    /// The indices that fit, taking columns in priority order.
    private func visible(_ subviews: Subviews, width: CGFloat) -> Set<Int> {
        var chosen = Set<Int>()
        var used: CGFloat = 0
        for index in subviews.indices.sorted(by: { spec(subviews[$0]).priority < spec(subviews[$1]).priority }) {
            let needed = used + spec(subviews[index]).width + (chosen.isEmpty ? 0 : spacing)
            if needed > width && !chosen.isEmpty { break }
            chosen.insert(index)
            used = needed
        }
        return chosen
    }

    private func widths(_ subviews: Subviews, shown: Set<Int>, total: CGFloat) -> [CGFloat] {
        let fixed = shown.filter { !spec(subviews[$0]).flexible }.map { spec(subviews[$0]).width }.reduce(0, +)
        let gaps = spacing * CGFloat(max(0, shown.count - 1))
        let flexibleCount = shown.filter { spec(subviews[$0]).flexible }.count
        let share = flexibleCount > 0 ? max(0, total - fixed - gaps) / CGFloat(flexibleCount) : 0
        return subviews.indices.map { index in
            let spec = spec(subviews[index])
            return spec.flexible ? max(spec.width, share) : spec.width
        }
    }
}
