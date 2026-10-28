import Foundation
import SwiftUI

struct Course: Identifiable, Hashable {
    let code: String
    let name: String
    let hasDoc: Bool
    var id: String { code }
}

/// Runs the lecture-notes pipeline natively: Start records through Dash's own jarvis; every
/// five minutes the new transcript becomes notes (Claude, no tools) appended to the class's
/// Google Doc; Stop files the rest, rewrites the day's notes cleanly, and deletes the raw
/// transcript. Same steps as the lecture-notes skill, without a Claude Code session or cron.
@MainActor
final class LectureController: ObservableObject {
    enum State: Equatable {
        case idle
        case starting
        case recording(Course, since: Date)
        case stopping(Course)
    }

    struct LogLine: Identifiable {
        let id = UUID()
        let time = Date()
        let text: String
        var isError = false
    }

    @Published var courses: [Course] = []
    @Published var selected: String?
    @Published var state: State = .idle
    @Published var log: [LogLine] = []
    @Published private(set) var buffered: String = ""
    /// Bumped by the timer so the elapsed time on screen updates.
    @Published private(set) var tick = 0

    private let jarvis: JarvisClient
    private var loop: Task<Void, Never>?
    private var notesPass: Task<Void, Never>?
    /// How much of transcript.txt has already become notes, so a recording that ends on its
    /// own (jarvis crashed, mic stopped) can still file the rest from disk.
    private var consumedBytes: UInt64 = 0

    static let coursesURL = Personal.home.appendingPathComponent("BrightspaceToDo/courses.json")
    static let sessionsDir = Personal.home.appendingPathComponent("LectureNotes/sessions", isDirectory: true)
    static let interval: UInt64 = 5 * 60

    init(jarvis: JarvisClient) {
        self.jarvis = jarvis
        loadCourses()
    }

    var isRecording: Bool { if case .recording = state { true } else { false } }
    var isActive: Bool { state != .idle }

    func loadCourses() {
        guard let data = try? Data(contentsOf: Self.coursesURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = json["courses"] as? [[String: Any]]
        else { return }
        courses = list.compactMap { entry in
            guard let code = entry["code"] as? String else { return nil }
            return Course(code: code, name: entry["name"] as? String ?? code,
                          hasDoc: (entry["googleDocId"] as? String)?.isEmpty == false)
        }
        if selected == nil { selected = courses.first?.code }
    }

    /// Picks the class that's on now (or starts within 15 minutes) from Today's calendar.
    func suggest(from events: [CalendarEvent]) {
        guard !isActive else { return }
        let now = Date()
        let current = events.first { event in
            guard let code = event.courseCode, courses.contains(where: { $0.code == code }), !event.allDay
            else { return false }
            return event.start.addingTimeInterval(-15 * 60) <= now && (event.end ?? event.start) > now
        }
        if let code = current?.courseCode { selected = code }
    }

    func start() {
        guard state == .idle, let course = courses.first(where: { $0.code == selected }) else { return }
        state = .starting
        log = []
        Task {
            do {
                var reply = try await jarvis.call("lecture_start", ["course_code": course.code])
                if reply.contains("doesn't have a lecture-notes Doc") {
                    note("Setting up a notes Doc for \(course.code)…")
                    note(try await jarvis.call("lecture_bootstrap_course", ["course_code": course.code]))
                    reply = try await jarvis.call("lecture_start", ["course_code": course.code])
                }
                guard reply.hasPrefix("Recording started") else {
                    note(reply, isError: true)
                    state = .idle
                    return
                }
                state = .recording(course, since: Date())
                consumedBytes = 0
                MemoryModel.shared.log(source: "lecture", kind: "started", text: "Started recording \(course.code) (\(course.name))")
                note("Recording \(course.code). Notes go to its Doc every 5 minutes.")
                runLoop(for: course)
            } catch {
                note(error.localizedDescription, isError: true)
                // A slow start (the mic permission dialog, say) can time out here while jarvis goes
                // on to start recording anyway. Check, so a recording never runs unseen.
                if let status = try? await jarvis.call("lecture_status"), !status.isEmpty,
                   !status.hasPrefix("No lecture") {
                    state = .recording(course, since: Date())
                    consumedBytes = 0
                    note("Recording \(course.code) (it finished starting after a delay).")
                    runLoop(for: course)
                } else {
                    state = .idle
                }
            }
        }
    }

    func stop() {
        guard case .recording(let course, let since) = state else { return }
        loop?.cancel()
        loop = nil
        Task {
            await finish(course, since: since) {
                let reply = try await self.jarvis.call("lecture_stop")
                guard let range = reply.range(of: "Final unprocessed transcript:\n") else { return "" }
                return String(reply[range.upperBound...])
            }
        }
    }

    /// The end of every recording, whether the user pressed Stop or it ended on its own: file the
    /// leftover transcript, rewrite the day's notes, and delete the raw transcript.
    private func finish(_ course: Course, since: Date, leftover: () async throws -> String) async {
        state = .stopping(course)
        let minutes = Int(Date().timeIntervalSince(since) / 60)
        MemoryModel.shared.log(source: "lecture", kind: "finished", text: "Recorded \(minutes) minutes of \(course.code) (\(course.name)); notes are in its Google Doc")
        await notesPass?.value
        do {
            let rest = try await leftover().trimmingCharacters(in: .whitespacesAndNewlines)
            if rest.count > 80, await !file(rest, for: course) {
                throw JarvisError.failed("Kept the raw transcript in ~/LectureNotes/sessions since the last notes didn't file.")
            }
            note("Recording stopped. Cleaning up today's notes…")
            try await cleanUp(course)
            // Only once everything is safely in the Doc.
            deleteTranscript(for: course, since: since)
        } catch {
            note(error.localizedDescription, isError: true)
        }
        state = .idle
        buffered = ""
    }

    private func runLoop(for course: Course) {
        guard case .recording(_, let since) = state else { return }
        loop = Task {
            var seconds: UInt64 = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                guard !Task.isCancelled else { return }
                seconds += 30
                tick += 1
                if let status = try? await jarvis.call("lecture_status") {
                    if status.hasPrefix("No lecture") {
                        note("The recording ended on its own. Filing what was captured.", isError: true)
                        loop = nil
                        await finish(course, since: since) { self.unreadTranscript(for: course, since: since) }
                        return
                    }
                    buffered = status
                }
                if seconds % Self.interval == 0 {
                    let pass = Task { await self.fileNewTranscript(for: course) }
                    notesPass = pass
                    await pass.value
                }
            }
        }
    }

    private func fileNewTranscript(for course: Course) async {
        do {
            let text = try await jarvis.call("lecture_get_new_transcript")
            if let url = sessionFolder(for: course)?.appendingPathComponent("transcript.txt"),
               let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? UInt64 {
                consumedBytes = size
            }
            guard !text.hasPrefix("(no new speech"), !text.hasPrefix("No lecture") else {
                note("No new speech in the last 5 minutes.")
                return
            }
            await file(text, for: course)
        } catch {
            note(error.localizedDescription, isError: true)
        }
    }

    /// Transcript chunk → notes → appended to the class's Doc. False if it didn't make it there.
    @discardableResult
    private func file(_ transcript: String, for course: Course) async -> Bool {
        do {
            let notes = try await ClaudeSession.ask(
                "Class: \(course.code) (\(course.name))\n\n<transcript>\n\(transcript)\n</transcript>",
                system: Prompts.lectureNotes)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !notes.isEmpty, notes != "NOTHING" else {
                note("Nothing worth noting in that stretch.")
                return true
            }
            let reply = try await jarvis.call("docs_append_notes", ["course_code": course.code, "text": notes])
            guard reply.hasPrefix("Appended") else { throw JarvisError.failed(reply) }
            note("Filed \(notes.split(separator: " ").count) words of notes to the Doc.")
            return true
        } catch {
            note("Couldn't file notes: \(error.localizedDescription)", isError: true)
            return false
        }
    }

    private func cleanUp(_ course: Course) async throws {
        let today = Self.dayString(Date())
        let section = try await jarvis.call("docs_read_section", ["course_code": course.code, "date": today])
        if section.hasPrefix("Failed") { throw JarvisError.failed(section) }
        guard !section.hasPrefix("No lecture section"), section.split(separator: " ").count > 40 else {
            note("Not much in today's notes, so I left them as they are.")
            return
        }
        let cleaned = try await ClaudeSession.ask(
            "Class: \(course.code) (\(course.name)), \(today)\n\n<todays_notes>\n\(section)\n</todays_notes>",
            system: Prompts.lectureCleanup, effort: "medium")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.count > 100 else { throw JarvisError.failed("The cleanup came back empty, so I kept the original notes.") }
        // The replacement has to carry its own date header, or the section loses it.
        let header = "=== Lecture: \(today) ==="
        let text = cleaned.hasPrefix(header) ? cleaned : "\(header)\n\n\(cleaned)"
        let reply = try await jarvis.call("docs_replace_section",
                                          ["course_code": course.code, "date": today, "new_text": text + "\n"])
        if reply.lowercased().hasPrefix("failed") || reply.hasPrefix("No lecture") { throw JarvisError.failed(reply) }
        note("Rewrote today's notes into one clean set.")
    }

    /// Transcript text on disk that never became notes.
    private func unreadTranscript(for course: Course, since: Date) -> String {
        guard let url = sessionFolder(for: course, since: since)?.appendingPathComponent("transcript.txt"),
              let handle = try? FileHandle(forReadingFrom: url)
        else { return "" }
        defer { try? handle.close() }
        try? handle.seek(toOffset: consumedBytes)
        return String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
    }

    /// This recording's raw transcript folder: the newest `<code>-<timestamp>` folder whose
    /// timestamp is from this recording.
    private func sessionFolder(for course: Course, since: Date? = nil) -> URL? {
        guard let since = since ?? { if case .recording(_, let since) = state { since } else { nil } }()
        else { return nil }
        let prefix = "\(course.code)-"
        let folders = (try? FileManager.default.contentsOfDirectory(atPath: Self.sessionsDir.path)) ?? []
        let match = folders
            .filter { $0.hasPrefix(prefix) }
            .compactMap { name -> (String, Date)? in
                Self.folderFormat.date(from: String(name.dropFirst(prefix.count))).map { (name, $0) }
            }
            .filter { abs($0.1.timeIntervalSince(since)) < 120 }
            .max { $0.1 < $1.1 }
        return match.map { Self.sessionsDir.appendingPathComponent($0.0, isDirectory: true) }
    }

    private static let folderFormat: DateFormatter = {
        let format = DateFormatter()
        format.dateFormat = "yyyyMMdd-HHmmss"
        return format
    }()

    /// Deletes this recording's raw transcript folder, and only that one.
    private func deleteTranscript(for course: Course, since: Date) {
        guard let folder = sessionFolder(for: course, since: since) else {
            note("Couldn't find this recording's transcript folder to delete.", isError: true)
            return
        }
        do {
            try FileManager.default.removeItem(at: folder)
            note("Deleted the raw transcript. Only the Doc notes remain.")
        } catch {
            note("Couldn't delete the transcript: \(error.localizedDescription)", isError: true)
        }
    }

    private func note(_ text: String, isError: Bool = false) {
        log.append(LogLine(text: text, isError: isError))
    }

    static func dayString(_ date: Date) -> String {
        let format = DateFormatter()
        format.dateFormat = "yyyy-MM-dd"
        return format.string(from: date)
    }
}
