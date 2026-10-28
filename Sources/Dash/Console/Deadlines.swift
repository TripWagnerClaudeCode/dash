import SwiftUI

/// Deadlines and exams Dash tracks on the hub (hub/src/deadlines.ts), fed from the calendar, new syllabi
/// and chats, and the source of the phone's reminders. Dates from a syllabus wait for a Confirm.
@MainActor
final class DeadlinesModel: ObservableObject {
    struct Item: Identifiable, Equatable {
        let id: String
        let due: Date
        let course: String?
        let title: String
        let exam: Bool
        let confirmed: Bool
        let source: String?
    }

    @Published private(set) var items: [Item] = []
    @Published private(set) var notice: String?
    private var hub: HubClient?

    var isAvailable: Bool { hub?.isPaired == true }

    func useHub(_ hub: HubClient) {
        self.hub = hub
        hub.on("deadlines") { [weak self] data in self?.apply(data) }
    }

    func confirm(_ item: Item) { change("deadlines.confirm", item) }
    func done(_ item: Item) { change("deadlines.done", item) }
    func dismiss(_ item: Item) { change("deadlines.dismiss", item) }

    private func change(_ type: String, _ item: Item) {
        guard let hub, hub.isOnline else { notice = hub?.offlineMessage; return }
        Task {
            do {
                apply(try await hub.request(type, ["item": item.id]))
                notice = nil
            } catch {
                notice = error.localizedDescription
            }
        }
    }

    private func apply(_ data: [String: Any]) {
        items = (data["items"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let id = entry["id"] as? String, let title = entry["title"] as? String, let due = HubClient.date(entry["due"]) else { return nil }
            return Item(id: id, due: due, course: entry["course"] as? String, title: title, exam: entry["exam"] as? Bool ?? false,
                        confirmed: entry["confirmed"] as? Bool ?? true, source: entry["source"] as? String)
        }
    }

    /// Sample data for `Dash --preview today`.
    func showSample() {
        let day: (Double) -> Date = { Date().addingTimeInterval($0 * 86_400) }
        items = [Item(id: "1", due: day(0.3), course: "SPAN1010B", title: "Supersite HW", exam: false, confirmed: true, source: "calendar"),
                 Item(id: "2", due: day(1), course: "POLS1000A", title: "Exam #3", exam: true, confirmed: true, source: "calendar"),
                 Item(id: "3", due: day(3), course: "FILM1200A", title: "Shadows screening notes", exam: false, confirmed: true, source: "calendar"),
                 Item(id: "4", due: day(9), course: "ECON3100A", title: "Problem set 3", exam: false, confirmed: false, source: "syllabus")]
    }
}

struct DeadlinesCard: View {
    @ObservedObject var deadlines: DeadlinesModel
    private static let shown = 8

    var body: some View {
        Card(title: "Deadlines", icon: "alarm") {
            VStack(alignment: .leading, spacing: 7) {
                if deadlines.items.isEmpty {
                    Text("Nothing due. Dash adds exams and due dates from your calendar, new syllabi in Documents/Syllabi, and anything you mention in a chat.")
                        .font(.system(size: 12.5)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(deadlines.items.prefix(Self.shown)) { item in
                    DeadlineRow(item: item, deadlines: deadlines)
                }
                if deadlines.items.count > Self.shown {
                    Text("and \(deadlines.items.count - Self.shown) more").font(.system(size: 11.5)).foregroundStyle(.secondary)
                }
                if let notice = deadlines.notice {
                    Text(notice).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct DeadlineRow: View {
    let item: DeadlinesModel.Item
    @ObservedObject var deadlines: DeadlinesModel
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(Self.when(item.due))
                .font(.system(size: 11.5, weight: .medium).monospacedDigit())
                .foregroundStyle(Self.isSoon(item.due) ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                .frame(width: 92, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    if item.exam {
                        Text("EXAM").font(.system(size: 9, weight: .bold)).padding(.horizontal, 4).padding(.vertical, 1)
                            .background(.tint.opacity(0.18), in: RoundedRectangle(cornerRadius: 3))
                    }
                    Text([item.course, item.title].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 12.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !item.confirmed {
                    HStack(spacing: 8) {
                        Text("From the \(item.source ?? "syllabus"). Right?").font(.system(size: 11)).foregroundStyle(.secondary)
                        Button("Confirm") { deadlines.confirm(item) }
                        Button("Remove") { deadlines.dismiss(item) }
                    }
                    .controlSize(.mini)
                }
            }
            Spacer(minLength: 0)
            if item.confirmed {
                HStack(spacing: 6) {
                    if !item.exam {
                        Button { deadlines.done(item) } label: { Image(systemName: "checkmark") }.help("Done")
                    }
                    Button { deadlines.dismiss(item) } label: { Image(systemName: "xmark") }.help("Remove (it won't come back)")
                }
                .buttonStyle(.plain)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
                .opacity(hovering ? 1 : 0)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }

    static func isSoon(_ date: Date) -> Bool { date.timeIntervalSinceNow < 36 * 3_600 }

    /// "Today 11:59 PM", "Tomorrow 9:40 AM", "Fri 12:00 PM", "Nov 18".
    static func when(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(date) { return "Today \(time)" }
        if Calendar.current.isDateInTomorrow(date) { return "Tmrw \(time)" }
        if date.timeIntervalSinceNow < 6 * 86_400 { return "\(date.formatted(.dateTime.weekday(.abbreviated))) \(time)" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
