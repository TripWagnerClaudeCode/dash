import Combine
import Foundation

/// Lets the phone start and stop lecture recording on this Mac through the Dash hub. Recording itself
/// stays here (it needs this Mac's microphone and its jarvis); this reports the recorder's state to the
/// hub, which shows it on the phone, and runs the Start/Stop the hub passes on.
@MainActor
final class LectureRemote {
    private let hub: HubClient
    private let lecture: LectureController
    private var watches: Set<AnyCancellable> = []
    private var pendingReport: DispatchWorkItem?

    init(hub: HubClient, lecture: LectureController) {
        self.hub = hub
        self.lecture = lecture
        hub.on("command") { [weak self] command in self?.run(command) }
        lecture.objectWillChange.sink { [weak self] _ in self?.scheduleReport() }.store(in: &watches)
        hub.$state.sink { [weak self] state in
            if state == .online { self?.scheduleReport() }
        }.store(in: &watches)
    }

    private func run(_ command: [String: Any]) {
        switch command["type"] as? String {
        case "lecture.start":
            if let code = command["course"] as? String, lecture.courses.contains(where: { $0.code == code }) {
                lecture.selected = code
            }
            Log.write("hub: phone started a lecture recording (\(lecture.selected ?? "?"))")
            lecture.start()
        case "lecture.stop":
            Log.write("hub: phone stopped the lecture recording")
            lecture.stop()
        default:
            break
        }
    }

    /// Changes come in bursts (the elapsed-time tick, log lines); send one report after they settle.
    private func scheduleReport() {
        pendingReport?.cancel()
        let work = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.report() } }
        pendingReport = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    private func report() {
        guard hub.isOnline else { return }
        let iso = ISO8601DateFormatter()
        var state: [String: Any] = [
            "selected": lecture.selected ?? NSNull(),
            "courses": lecture.courses.map { ["code": $0.code, "name": $0.name, "hasDoc": $0.hasDoc] },
            "log": lecture.log.suffix(6).map { ["time": iso.string(from: $0.time), "text": $0.text, "isError": $0.isError] },
        ]
        switch lecture.state {
        case .idle:
            state["state"] = "idle"
        case .starting:
            state["state"] = "starting"
        case .recording(let course, let since):
            state["state"] = "recording"
            state["course"] = course.code
            state["courseName"] = course.name
            state["since"] = iso.string(from: since)
        case .stopping(let course):
            state["state"] = "stopping"
            state["course"] = course.code
            state["courseName"] = course.name
        }
        Task { _ = try? await hub.request("lecture.report", ["state": state]) }
    }
}
