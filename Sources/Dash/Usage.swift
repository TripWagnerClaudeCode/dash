import Foundation
import SwiftUI

/// How much of the Claude subscription is used: the 5-hour session window and the 7-day
/// window. Claude Code reports both on every request (its `rate_limit_event`), so any Claude
/// call Dash makes keeps this current; `refresh()` sends a tiny Haiku ping when nothing has lately.
@MainActor
final class Usage: ObservableObject {
    struct Window: Codable, Equatable {
        /// 0…1 of the window's limit.
        var utilization: Double
        var resetsAt: Date

        /// Once the reset time passes, the old percentage no longer applies.
        var hasReset: Bool { resetsAt <= Date() }
        var shown: Double { hasReset ? 0 : min(max(utilization, 0), 1) }
    }

    private struct Snapshot: Codable {
        var session: Window?
        var week: Window?
        var updatedAt: Date
        var limited: Bool
    }

    static let shared = Usage()

    @Published private(set) var session: Window?
    @Published private(set) var week: Window?
    @Published private(set) var updatedAt: Date?
    /// Claude Code said this request was over the limit.
    @Published private(set) var limited = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var error: String?

    private static let defaultsKey = "usageSnapshot"
    /// Older than this, Today pings for fresh numbers (usage from Claude Code or claude.ai
    /// elsewhere doesn't reach Dash on its own).
    static let maxAge: TimeInterval = 15 * 60

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) {
            session = snapshot.session
            week = snapshot.week
            updatedAt = snapshot.updatedAt
            limited = snapshot.limited
        }
    }

    /// Reads a `rate_limit_info` object from Claude Code's stream. Previews pass `persist: false`
    /// so sample numbers never overwrite the real ones.
    func update(from info: [String: Any], persist: Bool = true) {
        let windows = info["unifiedWindows"] as? [String: Any]
        func window(_ name: String) -> Window? {
            guard let entry = windows?[name] as? [String: Any],
                  let utilization = (entry["utilization"] as? NSNumber)?.doubleValue,
                  let resets = (entry["resetsAt"] as? NSNumber)?.doubleValue
            else { return nil }
            return Window(utilization: utilization, resetsAt: Date(timeIntervalSince1970: resets))
        }
        session = window("five_hour") ?? session
        week = window("seven_day") ?? week
        limited = info["status"] as? String == "rejected"
        updatedAt = Date()
        error = nil
        guard persist else { return }
        save()
        forward?(info)
    }

    /// Set once paired with the Dash hub, so the hub (and the phone) see numbers from this Mac's own calls.
    var forward: (([String: Any]) -> Void)?

    /// Numbers from the hub's `usage` event (its chats and brief use the same subscription), when they're
    /// newer than this Mac's own.
    func applyHub(_ snapshot: [String: Any]) {
        guard let stamp = HubClient.date(snapshot["updatedAt"]), stamp > (updatedAt ?? .distantPast) else { return }
        func window(_ name: String) -> Window? {
            guard let entry = snapshot[name] as? [String: Any], let utilization = (entry["utilization"] as? NSNumber)?.doubleValue,
                  let resets = HubClient.date(entry["resetsAt"]) else { return nil }
            return Window(utilization: utilization, resetsAt: resets)
        }
        session = window("session") ?? session
        week = window("week") ?? week
        limited = snapshot["limited"] as? Bool ?? false
        updatedAt = stamp
        error = nil
        save()
    }

    private func save() {
        guard let updatedAt else { return }
        let snapshot = Snapshot(session: session, week: week, updatedAt: updatedAt, limited: limited)
        if let data = try? JSONEncoder().encode(snapshot) { UserDefaults.standard.set(data, forKey: Self.defaultsKey) }
    }

    var isStale: Bool {
        guard let updatedAt else { return true }
        return Date().timeIntervalSince(updatedAt) > Self.maxAge || session?.hasReset == true
    }

    func refreshIfStale() {
        if isStale { refresh() }
    }

    /// Smallest possible request (Haiku, a few hundred tokens) just to read the current numbers.
    func refresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        Task {
            do {
                _ = try await ClaudeSession.ask("OK", system: "Reply with the single word OK.", model: .haiku)
            } catch {
                self.error = error.localizedDescription
            }
            isRefreshing = false
        }
    }

    // MARK: Formatting

    /// "2h 14m", "3d 4h", "12m".
    static func countdown(to date: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSinceNow))
        let days = seconds / 86400, hours = seconds % 86400 / 3600, minutes = seconds % 3600 / 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return minutes > 0 ? "\(minutes)m" : "<1m"
    }

    /// "3:00 PM" today, "Sat 3:00 PM" otherwise.
    static func clock(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }

    static func color(for fraction: Double) -> Color {
        switch fraction {
        case ..<0.5: .green
        case ..<0.8: .yellow
        default: .red
        }
    }
}

/// A horizontal meter for one usage window.
struct UsageMeter: View {
    let fraction: Double
    var height: CGFloat = 8

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(Usage.color(for: fraction).gradient)
                    .frame(width: max(fraction > 0 ? height : 0, proxy.size.width * fraction))
            }
        }
        .frame(height: height)
        .animation(.easeOut(duration: 0.4), value: fraction)
    }
}

/// The Today card: session and weekly usage, each with a meter and reset countdown.
struct UsageCard: View {
    @ObservedObject var usage = Usage.shared

    var body: some View {
        Card(title: "Claude usage", icon: "gauge.with.dots.needle.50percent") {
            HStack(spacing: 8) {
                if let updated = usage.updatedAt {
                    TimelineView(.periodic(from: .now, by: 30)) { _ in
                        Text("Updated \(updated.formatted(.relative(presentation: .named)))")
                            .font(.system(size: 11)).foregroundStyle(.tertiary)
                    }
                }
                if usage.isRefreshing {
                    ProgressView().controlSize(.mini)
                } else {
                    Button { usage.refresh() } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .help("Check current usage (a tiny Haiku request)")
                }
            }
        } content: {
            TimelineView(.periodic(from: .now, by: 30)) { _ in
                VStack(alignment: .leading, spacing: 10) {
                    if usage.limited {
                        Label("You've hit a usage limit. Claude answers again after the reset below.",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 12)).foregroundStyle(.red)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 24) {
                            row("Session", detail: "5-hour window", window: usage.session)
                            row("Week", detail: "all models", window: usage.week)
                        }
                        VStack(alignment: .leading, spacing: 14) {
                            row("Session", detail: "5-hour window", window: usage.session)
                            row("Week", detail: "all models", window: usage.week)
                        }
                    }
                    if let error = usage.error, usage.session == nil {
                        Text(error).font(.system(size: 11.5)).foregroundStyle(.orange)
                    }
                }
            }
        }
    }

    private func row(_ title: String, detail: String, window: Usage.Window?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(detail).font(.system(size: 11)).foregroundStyle(.tertiary)
                Spacer()
                Text(window.map { "\(Int(($0.shown * 100).rounded()))%" } ?? "—")
                    .font(.system(size: 17, weight: .semibold).monospacedDigit())
                    .foregroundStyle(window.map { Usage.color(for: $0.shown) } ?? .secondary)
            }
            UsageMeter(fraction: window?.shown ?? 0)
            Group {
                if let window, !window.hasReset {
                    Text("Resets in **\(Usage.countdown(to: window.resetsAt))** · \(Usage.clock(window.resetsAt))")
                } else if window != nil {
                    Text("Reset. Refresh for the new window.")
                } else {
                    Text("Not checked yet")
                }
            }
            .font(.system(size: 11.5)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Compact version for the bottom of the console sidebar, visible from every page.
struct UsageSidebarFooter: View {
    @ObservedObject var usage = Usage.shared

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            VStack(alignment: .leading, spacing: 8) {
                line("Session", usage.session)
                line("Week", usage.week)
            }
        }
        .padding(12)
        .help("Claude subscription usage. Details on Today.")
    }

    private func line(_ title: String, _ window: Usage.Window?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(title)
                Spacer()
                if let window {
                    Text("\(Int((window.shown * 100).rounded()))%").monospacedDigit()
                    if !window.hasReset {
                        Text("· \(Usage.countdown(to: window.resetsAt))").foregroundStyle(.tertiary).monospacedDigit()
                    }
                } else {
                    Text("—").foregroundStyle(.tertiary)
                }
            }
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            UsageMeter(fraction: window?.shown ?? 0, height: 4)
        }
    }
}
