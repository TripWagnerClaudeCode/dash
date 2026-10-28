import SwiftUI

// MARK: Lens

/// The ⌥A conversation, bigger. Same session as the floating panel.
struct LensPage: View {
    @EnvironmentObject var session: Session
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if let capture = session.capture {
                    Image(nsImage: capture.thumbnail)
                        .resizable().aspectRatio(contentMode: .fit)
                        .frame(height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(capture.appName).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                        Text(capture.windowTitle).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                // Labels first; icon-only when the window is too narrow for them.
                ViewThatFits(in: .horizontal) {
                    lensButtons(labels: true)
                    lensButtons(labels: false)
                }
            }
            .controlSize(.small)
            .padding(.horizontal, 18)
            .padding(.vertical, 10)

            ConversationScroll(conversation: session) {
                Text("Press ⌥A over any window (VHL Central, a reading, a problem set) and Dash answers what's on screen. The same conversation shows up here and in the floating panel.")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 30)
            }
            Composer(placeholder: session.capture == nil ? "Ask anything…" : "Ask about this screen…",
                     draft: $draft, isBusy: session.isBusy,
                     send: { session.ask(.ask, question: draft); draft = "" },
                     stop: { session.stop() })
        }
    }
}

extension LensPage {
    @ViewBuilder fileprivate func lensButtons(labels: Bool) -> some View {
        HStack(spacing: 8) {
            ForEach([Mode.answer, .hint, .explain, .check]) { mode in
                Button { session.ask(mode) } label: {
                    if labels { Label(mode.label, systemImage: mode.icon) } else { Image(systemName: mode.icon) }
                }
                .help(mode.label)
                .disabled(session.isBusy || session.capture == nil)
            }
            Button { session.recapture() } label: {
                if labels { Label("Capture", systemImage: "camera.viewfinder") } else { Image(systemName: "camera.viewfinder") }
            }
            .help("Captures the last window you used before Dash (⌥A)")
        }
        .fixedSize()
    }
}

// MARK: Lecture

struct LecturePage: View {
    @EnvironmentObject var lecture: LectureController
    @EnvironmentObject var today: TodayModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PageTitle(title: "Lecture notes",
                          subtitle: "Records your mic and transcribes it on this Mac. Every 5 minutes the new part becomes notes in the class's Google Doc. When you stop, the day's notes get rewritten into one clean set and the raw transcript is deleted.")

                Card(title: "Class", icon: "graduationcap") {
                    HStack(spacing: 12) {
                        Picker("Class", selection: $lecture.selected) {
                            ForEach(lecture.courses) { course in
                                Text("\(course.code) · \(course.name)").tag(Optional(course.code))
                            }
                        }
                        .labelsHidden()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .layoutPriority(0)
                        .disabled(lecture.isActive)
                        control.fixedSize().layoutPriority(1)
                    }
                    status
                }

                if !lecture.log.isEmpty {
                    Card(title: "Activity", icon: "list.bullet.rectangle") {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(lecture.log.reversed()) { line in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(line.time.formatted(date: .omitted, time: .shortened))
                                        .font(.system(size: 11).monospacedDigit()).foregroundStyle(.tertiary)
                                    Text(line.text).font(.system(size: 12.5))
                                        .foregroundStyle(line.isError ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary))
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                }
            }
            .pageContainer()
        }
        .onAppear {
            lecture.loadCourses()
            if let events = today.events.value { lecture.suggest(from: events) }
        }
    }

    @ViewBuilder private var control: some View {
        switch lecture.state {
        case .idle:
            Button { lecture.start() } label: { Label("Start recording", systemImage: "record.circle") }
                .buttonStyle(.borderedProminent).tint(.red)
                .disabled(lecture.selected == nil)
        case .starting:
            ProgressView().controlSize(.small)
        case .recording:
            Button { lecture.stop() } label: { Label("Stop & file notes", systemImage: "stop.circle") }
                .buttonStyle(.borderedProminent)
        case .stopping:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Filing notes…").font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var status: some View {
        if case .recording(let course, let since) = lecture.state {
            HStack(spacing: 8) {
                Circle().fill(.red).frame(width: 8, height: 8)
                Text("Recording \(course.code) since \(since.formatted(date: .omitted, time: .shortened)). Keep Dash open until you stop.")
                    .font(.system(size: 12.5))
                    .id(lecture.tick)
            }
        } else if case .stopping(let course) = lecture.state {
            Text("Stopping \(course.code) and cleaning up today's notes. This takes a minute.")
                .font(.system(size: 12.5)).foregroundStyle(.secondary)
        }
    }
}

// MARK: Study

struct StudyPage: View {
    @EnvironmentObject var console: Console

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageTitle(title: "Study")
                ForEach(Toolbox.sections, id: \.title) { section in
                    let buttons = section.buttons.filter(\.isAvailable)
                    if !buttons.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(section.title.uppercased())
                                .font(.sectionLabel).foregroundStyle(.secondary)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 10)], spacing: 10) {
                                ForEach(buttons) { button in
                                    ToolTile(button: button) { console.launch(button) }
                                }
                            }
                        }
                    }
                }
            }
            .pageContainer()
        }
    }
}

private struct ToolTile: View {
    let button: ToolButton
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: button.icon)
                    .font(.system(size: 17))
                    .foregroundStyle(.tint)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text(button.title).font(.system(size: 13, weight: .semibold))
                    Text(button.subtitle).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface(radius: 10, hovering: hovering)
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
