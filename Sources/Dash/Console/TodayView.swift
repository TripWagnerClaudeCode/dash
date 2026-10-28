import SwiftUI

struct TodayView: View {
    @EnvironmentObject var console: Console
    @EnvironmentObject var today: TodayModel
    @EnvironmentObject var lecture: LectureController

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let hub = today.hub, hub.isPaired { HubProblems(hub: hub) }
                quickActions
                BriefCard(brief: today.brief, canGenerate: today.canBrief) { today.briefMe() }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 14, alignment: .top)],
                          alignment: .leading, spacing: 14) {
                    ScheduleCard(events: today.events)
                    if today.deadlines.isAvailable || DebugPreview.isRunning { DeadlinesCard(deadlines: today.deadlines) }
                    ToDoCard(list: today.todos)
                    InboxCard(inbox: today.inbox)
                    UsageCard()
                }
            }
            .pageContainer()
        }
        .onAppear {
            today.todos.reload()
            today.refreshIfStale()
            // Paired, the hub keeps usage current and sends it here; no need for this Mac's own Haiku ping.
            if today.hub?.isPaired != true { Usage.shared.refreshIfStale() }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(greeting).font(.pageTitle)
                Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                if let hub = today.hub, hub.isPaired { HubStatusLine(hub: hub) }
                // Weather lives in the header instead of taking a whole card.
                if case .loaded(let weather) = today.weather {
                    Label(weather, systemImage: "cloud.sun")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .lineLimit(2)
                        .padding(.top, 2)
                }
            }
            Spacer()
            Button { today.refresh() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                .disabled(today.isLoading)
        }
    }

    /// "Good morning, Alex", or just "Good morning" when the profile has no name.
    private var greeting: String {
        let time = switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: "Good morning"
        case 12..<17: "Good afternoon"
        default: "Good evening"
        }
        return Profile.current.firstName.map { "\(time), \($0)" } ?? time
    }

    /// One-tap jumps into the other tools.
    private var quickActions: some View {
        FlowRow(spacing: 8) {
            Button { console.chat("What's due this week, and what should I start first?", send: true) } label: {
                Label("What's due?", systemImage: "checklist")
            }
            Button { console.page = .lecture } label: {
                Label(lecture.isActive ? "Lecture recording…" : "Start lecture", systemImage: "waveform")
            }
            if let schoolTabs = Toolbox.schoolTabs {
                Button { console.launch(schoolTabs) } label: {
                    Label("School tabs", systemImage: "rectangle.stack")
                }
            }
            Button { console.chat("Draft an email to ", send: false) } label: {
                Label("Draft email", systemImage: "square.and.pencil")
            }
            Button { console.chat("Add to my calendar: ", send: false) } label: {
                Label("Add event", systemImage: "calendar.badge.plus")
            }
        }
        .controlSize(.large)
    }
}

/// What the hub's health check found wrong, so an expired sign-in doesn't go unnoticed for days.
struct HubProblems: View {
    @ObservedObject var hub: HubClient

    var body: some View {
        if !hub.problems.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(hub.problems, id: \.self) { problem in
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 12.5))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .foregroundStyle(.orange)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Where Today's data comes from: live from the hub, or the saved copy while the hub can't be reached.
struct HubStatusLine: View {
    @ObservedObject var hub: HubClient

    var body: some View {
        let (color, text): (Color, String) = switch hub.state {
        case .online: (.green, "Live from \(hub.credentials?.hub ?? "the Dash hub")")
        case .connecting: (.orange, "Connecting to \(hub.credentials?.hub ?? "the Dash hub")…")
        case .offline:
            (.orange, "Hub offline" + (hub.cacheDate("today").map {
                " · showing the copy from \($0.formatted(date: .omitted, time: .shortened))"
            } ?? ""))
        case .unpaired: (.secondary, "Not paired with the Dash hub")
        }
        Label {
            Text(text)
        } icon: {
            Circle().fill(color).frame(width: 6, height: 6)
        }
        .font(.system(size: 11.5))
        .foregroundStyle(.secondary)
        .help(hub.state == .online ? "" : hub.offlineMessage)
        .onTapGesture { hub.reconnectNow() }
    }
}

private struct BriefCard: View {
    @ObservedObject var brief: BriefConversation
    let canGenerate: Bool
    let generate: () -> Void

    var body: some View {
        Card(title: "Daily brief", icon: "sparkles") {
            Button(brief.turns.isEmpty ? "Brief me" : "Rewrite", action: generate)
                .controlSize(.small)
                .disabled(!canGenerate)
        } content: {
            if let answer = brief.turns.last(where: { $0.role == .assistant }) {
                TurnView(turn: answer, isLive: brief.isBusy, fontSize: 13.5)
            } else {
                Text("Your week at a glance, written from your calendar, to-dos, weather, and inbox.")
                    .font(.system(size: 12.5)).foregroundStyle(.secondary)
            }
        }
    }
}

private struct ScheduleCard: View {
    let events: Load<[CalendarEvent]>

    var body: some View {
        Card(title: "Next 7 days", icon: "calendar") {
            LoadView(load: events) { events in
                if events.isEmpty {
                    Text("Nothing on the calendar.").font(.system(size: 12.5)).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(days(events), id: \.day) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(label(for: group.day))
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                            ForEach(group.events) { event in row(event) }
                        }
                    }
                }
            }
        }
    }

    private func row(_ event: CalendarEvent) -> some View {
        let past = (event.end ?? event.start) < Date()
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(event.allDay ? "all day" : event.start.formatted(date: .omitted, time: .shortened))
                .font(.system(size: 11.5).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 62, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title).font(.system(size: 12.5)).lineLimit(2)
                if !event.place.isEmpty {
                    Text(event.place).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
        .opacity(past ? 0.45 : 1)
    }

    private func days(_ events: [CalendarEvent]) -> [(day: Date, events: [CalendarEvent])] {
        let grouped = Dictionary(grouping: events) { Calendar.current.startOfDay(for: $0.start) }
        return grouped.keys.sorted().map { ($0, grouped[$0]!.sorted { $0.start < $1.start }) }
    }

    private func label(for day: Date) -> String {
        if Calendar.current.isDateInToday(day) { return "TODAY" }
        if Calendar.current.isDateInTomorrow(day) { return "TOMORROW" }
        return day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()).uppercased()
    }
}

private struct ToDoCard: View {
    @ObservedObject var list: ToDoList
    @State private var draft = ""
    @FocusState private var adding: Bool

    var body: some View {
        Card(title: "To-do", icon: "checklist") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(list.items) { item in
                    ToDoRow(item: item, checked: list.checked.contains(item.id),
                            toggle: { list.toggle(item) }, delete: { list.delete(item) })
                }
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 16)
                    TextField("Add a to-do", text: $draft)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12.5))
                        .focused($adding)
                        .onSubmit {
                            let text = draft
                            draft = ""
                            // Back in the field if the hub didn't take it, unless something new was typed.
                            list.add(text) { if draft.isEmpty { draft = $0 } }
                            adding = true
                        }
                }
                .padding(.top, list.items.isEmpty ? 0 : 2)
                if let notice = list.notice {
                    Text(notice).font(.system(size: 11)).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .animation(.easeOut(duration: 0.15), value: list.items)
        }
    }
}

private struct ToDoRow: View {
    let item: ToDoItem
    let checked: Bool
    let toggle: () -> Void
    let delete: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button(action: toggle) {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 13))
                    .foregroundStyle(checked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .frame(width: 16)
            }
            .buttonStyle(.plain)
            .help(checked ? "Keep it" : "Check off")
            Text(item.text)
                .font(.system(size: 12.5))
                .strikethrough(checked)
                .foregroundStyle(checked ? .secondary : .primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 0)
            Button(action: delete) {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tertiary)
            .help("Delete")
            .opacity(hovering ? 1 : 0)
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

private struct InboxCard: View {
    let inbox: Load<[MailItem]>

    var body: some View {
        Card(title: "Inbox", icon: "envelope") {
            LoadView(load: inbox) { mail in
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(mail.prefix(6)) { item in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.from).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                            Text(item.subject).font(.system(size: 12.5)).lineLimit(1)
                        }
                    }
                }
            }
        }
    }
}
