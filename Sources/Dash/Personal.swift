import Foundation

/// What Dash knows about the user: ~/ABOUT_ME.md (courses, professors, schedule, weak spots) and
/// Dash's own memory file, which Claude edits when asked to remember something.
enum Personal {
    static let home = FileManager.default.homeDirectoryForCurrentUser

    /// ~/Library/Application Support/Dash: Claude Code's working directory and the memory file.
    /// DASH_SUPPORT moves it (to-do list, memory, hub-cache, chats, the log…), so command-line tests
    /// run with the debug build never share the installed app's files.
    static let supportDir: URL = {
        let url = ProcessInfo.processInfo.environment["DASH_SUPPORT"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Dash", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    static let aboutMeURL = home.appendingPathComponent("ABOUT_ME.md")
    static let memoryURL = supportDir.appendingPathComponent("memory.md")
    /// The to-do list on the Today page, which chats can edit too.
    static let todoURL = supportDir.appendingPathComponent("todo.md")
    /// Files Claude writes from the Study tools (practice exams, outlines…) land here.
    static let outputDir = home.appendingPathComponent("Documents/Dash", isDirectory: true)

    /// The user's goals as an investor, kept by the portfolio advisor and loaded into every session.
    static let investorProfileURL = supportDir.appendingPathComponent("investor_profile.md")
    private static let profileNotSetUp = "<!-- Not set up yet: the advisor fills this in during the first session. -->"

    static func investorProfile() -> String {
        if !FileManager.default.fileExists(atPath: investorProfileURL.path) {
            let template = """
            # Investor profile
            \(profileNotSetUp)

            ## Goals

            ## Time horizon & contributions

            ## Risk tolerance & limits

            ## Preferences & exclusions

            ## Tax situation

            ## Options comfort

            ## Decisions log

            """
            try? template.write(to: investorProfileURL, atomically: true, encoding: .utf8)
        }
        return (try? String(contentsOf: investorProfileURL, encoding: .utf8)) ?? ""
    }

    static var hasInvestorProfile: Bool { !investorProfile().contains(profileNotSetUp) }

    static func aboutMe() -> String {
        (try? String(contentsOf: aboutMeURL, encoding: .utf8)) ?? ""
    }

    static func memory() -> String {
        if !FileManager.default.fileExists(atPath: memoryURL.path) {
            try? "# Dash memory\n\nThings you asked Dash to remember, newest last.\n"
                .write(to: memoryURL, atomically: true, encoding: .utf8)
        }
        return (try? String(contentsOf: memoryURL, encoding: .utf8)) ?? ""
    }

    static var now: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE, MMMM d, yyyy 'at' h:mm a"
        return formatter.string(from: Date())
    }

    /// The system prompt for a console chat, optionally with a skill's instructions loaded.
    static func consoleSystem(skill: Skill? = nil) -> String {
        // Stable text first and the timestamp last, so the large blocks stay a cacheable prefix.
        var parts = [Prompts.console,
                     "<about_me>\n\(aboutMe())\n</about_me>",
                     "<dash_memory path=\"\(memoryURL.path)\">\n\(memory())\n</dash_memory>"]
        if let skill {
            parts.append("""
            \(Profile.current.whoCapitalized) launched the "\(skill.name)" skill from Dash. Follow its instructions below for this conversation. \
            Its folder is \(skill.directory.path); read any reference files it mentions from there with Read. \
            You can't show question widgets here, so where the skill says to ask the user something, just ask in \
            plain text. Save any files it produces in \(outputDir.path).

            <skill name="\(skill.name)">
            \(skill.instructions)
            </skill>
            """)
        }
        // The clock goes with each message instead (see ChatConversation.dispatch), so this prefix
        // stays identical between turns and can be cached.
        return parts.joined(separator: "\n\n")
    }

    /// Context for one-off prompts with no tools (the daily brief). No timestamp here, so it
    /// caches; the caller puts the time in the message.
    static var personalBackground: String {
        "<about_me>\n\(aboutMe())\n</about_me>\n\n<dash_memory>\n\(memory())\n</dash_memory>"
    }
}

/// Who the user is, for the few places Dash names them: ~/.dash-shared/profile.json, next to
/// ABOUT_ME.md (untracked, and read by the hub too). The file may be missing and every field is
/// optional. DASH_PROFILE points somewhere else, so command-line tests never read the real one.
struct Profile: Decodable {
    /// A button on the Study page: a web page (`url`) or a local file (`file`, ~ allowed).
    struct Link: Decodable {
        var title: String
        var subtitle: String?
        var icon: String?
        var url: String?
        var file: String?
    }

    var name: String?
    var fullName: String?
    var timezone: String?
    var crisisHelp: String?
    var links: [Link]?
    var studyApps: [Link]?

    static let url: URL = ProcessInfo.processInfo.environment["DASH_PROFILE"].map { URL(fileURLWithPath: $0) }
        ?? Personal.home.appendingPathComponent(".dash-shared/profile.json")

    /// Read once at launch. `Dash --preview` swaps in `sample`, so screenshots never show the real one.
    nonisolated(unsafe) static var current = load()

    static func load() -> Profile {
        guard let data = try? Data(contentsOf: url) else { return Profile() }
        do {
            return try JSONDecoder().decode(Profile.self, from: data)
        } catch {
            Log.write("profile: couldn't read \(url.path): \(error.localizedDescription)")
            return Profile()
        }
    }

    /// The user's first name, if the profile has one ("Good morning, Alex").
    var firstName: String? { Self.nonEmpty(name) }
    /// How prompts refer to the user mid-sentence: their name, or "the user".
    var who: String { firstName ?? "the user" }
    /// The same at the start of a sentence.
    var whoCapitalized: String { firstName ?? "The user" }
    /// Their full name, for "You are <full>'s assistant"; falls back to `who`.
    var full: String { Self.nonEmpty(fullName) ?? who }
    var timezoneName: String { Self.nonEmpty(timezone) ?? "local time" }
    var crisisHelpName: String { Self.nonEmpty(crisisHelp) ?? "a local or campus counseling service" }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        return value
    }

    /// A fictional profile for `Dash --preview`.
    static let sample = Profile(
        name: "Alex", fullName: "Alex Rivera", timezone: "Eastern",
        links: [Link(title: "School email", subtitle: "Outlook", icon: "envelope", url: "https://mail.example.edu"),
                Link(title: "Brightspace", subtitle: "Check for new work", icon: "graduationcap", url: "https://lms.example.edu"),
                Link(title: "Student portal", subtitle: "Portal", icon: "person.crop.square", url: "https://portal.example.edu")],
        studyApps: [Link(title: "Spanish Review", subtitle: "SPAN 1010 vocab + grammar", icon: "character.book.closed",
                         url: "https://example.com/spanish-review"),
                    Link(title: "HIST 2100 Cram", subtitle: "Exam 1 study", icon: "building.columns",
                         url: "https://example.com/hist-cram")])
}

/// A Claude Code skill from ~/.claude/skills, loaded into a console chat's system prompt.
struct Skill {
    let name: String
    let directory: URL
    let instructions: String

    static let root = Personal.home.appendingPathComponent(".claude/skills", isDirectory: true)

    static func exists(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent("\(name)/SKILL.md").path)
    }

    /// Every skill folder under ~/.claude/skills with its one-line description, for the / picker.
    static func all() -> [(name: String, description: String)] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return names.sorted().compactMap { name in
            guard let text = try? String(contentsOf: root.appendingPathComponent("\(name)/SKILL.md"), encoding: .utf8)
            else { return nil }
            return (name, description(in: text))
        }
    }

    /// The `description:` line of a SKILL.md's frontmatter (first line only), without quotes.
    private static func description(in text: String) -> String {
        guard text.hasPrefix("---"),
              let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 3)..<text.endIndex)
        else { return "" }
        for line in text[..<end.lowerBound].split(separator: "\n") where line.hasPrefix("description:") {
            return line.dropFirst("description:".count).trimmingCharacters(in: CharacterSet(charactersIn: " \"'>|"))
        }
        return ""
    }

    static func load(_ name: String) -> Skill? {
        let directory = root.appendingPathComponent(name, isDirectory: true)
        guard let text = try? String(contentsOf: directory.appendingPathComponent("SKILL.md"), encoding: .utf8)
        else { return nil }
        return Skill(name: name, directory: directory, instructions: text)
    }
}
