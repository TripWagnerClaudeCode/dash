import SwiftUI

/// What Dash remembers, from the hub: who the user is right now, follow-ups, "remember…" lines and the
/// nightly journal. Any line can be removed (Dash forgets it); the full log stays searchable on the hub.
struct MemoryPage: View {
    @ObservedObject var memory = MemoryModel.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top) {
                    PageTitle(title: "Memory",
                              subtitle: "What Dash remembers about you. Conversations are summarized when they go quiet, and each night the day becomes a journal entry and this page is updated. Hover a line and press × to make Dash forget it. Chats marked off the record are never remembered.")
                    Spacer()
                    Button { memory.load() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                        .controlSize(.small)
                        .disabled(memory.loading)
                }
                if let error = memory.error {
                    Text(error).font(.system(size: 12)).foregroundStyle(.orange)
                }
                if let snapshot = memory.snapshot {
                    Card(title: "Right now", icon: "person.crop.circle") {
                        MemoryLines(text: snapshot.core, empty: "Nothing yet. This fills in after the first night.") {
                            memory.forget(file: "core", line: $0)
                        }
                    }
                    Card(title: "Dash, in his own words", icon: "sparkles") {
                        MemoryLines(text: snapshot.selfNotes, empty: "Dash fills this in as you two get to know each other.") {
                            memory.forget(file: "self", line: $0)
                        }
                    }
                    Card(title: "Follow-ups", icon: "arrowshape.turn.up.forward") {
                        MemoryLines(text: snapshot.threads, empty: "Nothing to follow up on.") {
                            memory.forget(file: "threads", line: $0)
                        }
                    }
                    Card(title: "Asked to remember", icon: "pin") {
                        MemoryLines(text: snapshot.remember, empty: "Say \"remember…\" in a chat to add something here.") {
                            memory.forget(file: "remember", line: $0)
                        }
                    }
                    Card(title: "Journal", icon: "book.closed") {
                        if snapshot.journal.isEmpty {
                            Text("The first entry appears the morning after you use Dash.")
                                .font(.system(size: 12.5)).foregroundStyle(.secondary)
                        }
                        ForEach(snapshot.journal) { entry in
                            DisclosureGroup {
                                MemoryLines(text: entry.text, empty: "") {
                                    memory.forget(file: "journal", line: $0, day: entry.day)
                                }
                                .padding(.top, 4)
                            } label: {
                                Text(Self.dayTitle(entry.day)).font(.system(size: 13, weight: .medium))
                            }
                        }
                    }
                } else if memory.loading {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(24)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear { if !DebugPreview.isRunning { memory.load() } }
    }

    static func dayTitle(_ day: String) -> String {
        let parser = DateFormatter()
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: day) else { return day }
        return date.formatted(.dateTime.weekday(.wide).month(.wide).day())
    }
}

/// A memory file as lines: headings as labels, everything else removable on hover.
private struct MemoryLines: View {
    let text: String
    let empty: String
    let forget: (String) -> Void

    private var lines: [String] {
        text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter {
            !$0.isEmpty && !$0.hasPrefix("# ") && !$0.hasPrefix("<!--")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if lines.filter({ !$0.hasPrefix("## ") }).isEmpty, !empty.isEmpty {
                Text(empty).font(.system(size: 12.5)).foregroundStyle(.secondary)
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                if line.hasPrefix("## ") {
                    Text(line.dropFirst(3)).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
                        .padding(.top, 4)
                } else {
                    MemoryLine(line: line, forget: forget)
                }
            }
        }
    }
}

private struct MemoryLine: View {
    let line: String
    let forget: (String) -> Void
    @State private var hovering = false

    private var display: String {
        if line.hasPrefix("- [ ] ") { return "○ " + line.dropFirst(6) }
        if line.hasPrefix("- [x] ") { return "✓ " + line.dropFirst(6) }
        if line.hasPrefix("- ") { return "• " + line.dropFirst(2) }
        return line
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(display)
                .font(.system(size: 13))
                .foregroundStyle(line.hasPrefix("- [x] ") ? .secondary : .primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 4)
            Button { forget(line) } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .opacity(hovering ? 1 : 0)
                .help("Forget this")
        }
        .onHover { hovering = $0 }
    }
}
