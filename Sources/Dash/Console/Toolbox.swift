import AppKit

/// The buttons on the Study page. Edit `Toolbox.sections` to add or reorder skills; study apps and
/// school links come from profile.json.
struct ToolButton: Identifiable {
    enum Action {
        /// Opens a console chat with this ~/.claude/skills skill loaded, with `starter` in the field.
        case skill(String, starter: String)
        case url(String)
        case file(String)
        /// Several links at once (e.g. all school tabs).
        case urls([String])
    }

    let title: String
    let subtitle: String
    let icon: String
    let action: Action
    var id: String { title }

    /// Hides skills and local files that aren't on this Mac.
    var isAvailable: Bool {
        switch action {
        case .skill(let name, _): Skill.exists(name)
        case .file(let path): FileManager.default.fileExists(atPath: Toolbox.expand(path))
        case .url, .urls: true
        }
    }
}

enum Toolbox {
    /// The Study page hides a section with nothing available in it.
    static var sections: [(title: String, buttons: [ToolButton])] { [
        ("Study skills", [
            ToolButton(title: "Practice Exam", subtitle: "Mock exam + answer key from your notes",
                       icon: "checklist", action: .skill("practice-exam-builder", starter: "Make me a practice exam for ")),
            ToolButton(title: "Essay Outliner", subtitle: "Thesis and structure for a paper",
                       icon: "list.bullet.indent", action: .skill("essay-outliner", starter: "Help me outline ")),
            ToolButton(title: "Discussion Post", subtitle: "Draft a discussion board post",
                       icon: "bubble.left.and.text.bubble.right",
                       action: .skill("discussion-post-writer", starter: "Help me write a discussion post for ")),
            ToolButton(title: "Reading Digest", subtitle: "Summarize an assigned reading",
                       icon: "book.pages", action: .skill("reading-digest", starter: "Digest this reading: ")),
            ToolButton(title: "Proofread", subtitle: "Clarity and correctness pass",
                       icon: "text.magnifyingglass",
                       action: .skill("proofreader-clarity-editor", starter: "Proofread this: ")),
            ToolButton(title: "Lit Synthesizer", subtitle: "Pull sources into an argument",
                       icon: "books.vertical", action: .skill("literature-synthesizer", starter: "Synthesize these sources: ")),
            ToolButton(title: "Citations", subtitle: "Format sources and citations",
                       icon: "quote.opening", action: .skill("citation-source-formatter", starter: "Format these citations: ")),
        ]),
        ("Study apps", studyApps),
        ("School", (schoolTabs.map { [$0] } ?? []) + schoolLinks),
    ] }

    /// Your own study apps and school links, from `studyApps` and `links` in profile.json.
    static var studyApps: [ToolButton] { (Profile.current.studyApps ?? []).compactMap { button($0, icon: "app") } }
    static var schoolLinks: [ToolButton] { (Profile.current.links ?? []).compactMap { button($0, icon: "link") } }

    /// Opens every school link that's a web page at once. Nil when there are none.
    static var schoolTabs: ToolButton? {
        let links = (Profile.current.links ?? []).filter { $0.url != nil }
        guard !links.isEmpty else { return nil }
        return ToolButton(title: "All school tabs", subtitle: links.map(\.title).joined(separator: ", "),
                          icon: "rectangle.stack", action: .urls(links.compactMap(\.url)))
    }

    private static func button(_ link: Profile.Link, icon: String) -> ToolButton? {
        let action: ToolButton.Action
        if let url = link.url {
            action = .url(url)
        } else if let file = link.file {
            action = .file(file)
        } else {
            return nil
        }
        return ToolButton(title: link.title, subtitle: link.subtitle ?? "", icon: link.icon ?? icon, action: action)
    }

    static func expand(_ path: String) -> String {
        (path as NSString).expandingTildeInPath
    }

    static func open(_ url: String) {
        if let url = URL(string: url) { NSWorkspace.shared.open(url) }
    }

    static func openFile(_ path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: expand(path)))
    }
}
