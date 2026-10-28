<p align="center">
  <img src="docs/images/icon.png" width="112" alt="Dash icon">
</p>

<h1 align="center">Dash</h1>

<p align="center">
  <strong>A personal AI console for macOS and iPhone, with a lens over any window, a full Claude Code chat, and a secretary that never sleeps.</strong>
</p>

<p align="center">
  <img alt="macOS 14+" src="https://img.shields.io/badge/macOS-14%2B-000000?logo=apple&logoColor=white">
  <img alt="Swift" src="https://img.shields.io/badge/Swift-SwiftUI-F05138?logo=swift&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/hub-TypeScript%20%C2%B7%20Node%2024-3178C6?logo=typescript&logoColor=white">
  <img alt="Expo" src="https://img.shields.io/badge/iPhone-Expo%20SDK%2058-000020?logo=expo&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/jarvis-Python%20MCP-3776AB?logo=python&logoColor=white">
  <img alt="Claude Code" src="https://img.shields.io/badge/powered%20by-Claude%20Code-D97757">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  <img src="docs/images/today.png" width="880" alt="Dash's Today page: daily brief, calendar, deadlines, to-do and inbox">
</p>

> [!NOTE]
> Dash is a personal, single-user system: one Mac, one iPhone, one Google account, one always-on PC. Everything
> personal (your name, school links, addresses) lives in untracked config files described under
> [Configuration](#configuration), so the code itself is a template you can adapt.

## Contents

- [Highlights](#highlights)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Using Dash](#using-dash)
- [Security and privacy](#security-and-privacy)
- [Testing](#testing)
- [Further reading](#further-reading)

## Highlights

| | |
|---|---|
| **⌥A Lens** | A floating panel over the window you're in, e.g. VHL Central homework. Dash screenshots that window and answers in an overlay that stays on top. Answer, Hint, Explain or Check My Work. ⌥Space hides it. |
| **⌥L Console** | A full window with a sidebar of tools: Today, Chat, Lens, Lecture, Portfolio, Study and Memory. |
| **Today** | Claude usage (5-hour and weekly limits, with reset countdowns), the next 7 days of calendar, a to-do notepad, and deadlines from the calendar, syllabi and chats. Also weather, the inbox, and a written daily brief. |
| **Chat** | A full Claude Code session plus calendar, Gmail and lecture Docs. It reads files, runs commands, edits, searches the web and uses subagents. Anything that changes something shows an **Approve/Deny card** with the full command, diff or email. Chats are saved and resume with full context. They support markdown, pasted images and files, `/` skills, and per-chat model, effort and permissions. |
| **Lecture** | Start or stop recording a class. Every 5 minutes the new transcript becomes notes in that class's Google Doc. Stopping rewrites the day's notes cleanly and deletes the raw transcript. |
| **Portfolio** | Live Robinhood holdings against the S&P 500, gains, volatility, beta, drawdown, concentration and sectors. Plus an **Advisor**: a risk-manager persona that cites a source for every metric and never trades. |
| **Memory** | Dash remembers across Mac, phone and hub: a daily journal, core facts, follow-ups, his own notes on himself, and "remember…" lines. Every line can be forgotten. |
| **Secretary** | From an always-on hub: deadline reminders, a morning brief, an evening check-in and a twice-daily look around, pushed to the phone. Quiet hours run 11 PM to 8 AM. |
| **iPhone** | The same to-do, chats, portfolio, memory and lecture controls, in Expo Go. It works with the Mac closed. |

<p align="center">
  <img src="docs/images/portfolio.png" width="880" alt="Dash's Portfolio page with sample holdings: performance vs. the S&P 500 and risk metrics">
  <br><sub>Portfolio, shown with made-up sample holdings.</sub>
</p>

## Architecture

Dash's shared half runs on the **Dash hub**: an always-on service in WSL on a Windows PC, reached over Tailscale.
The Mac app and the iPhone app are both clients of it. The ⌥A lens and lecture recording stay on the Mac, which has
the screen and the microphone.

```mermaid
flowchart LR
    subgraph Mac["MacBook · Dash.app (Swift)"]
        Lens["⌥A Lens"]
        Console["⌥L Console"]
        Rec["Lecture recorder<br/>(jarvis)"]
    end

    subgraph Phone["iPhone"]
        App["Dash (Expo Go)"]
        Push["ntfy app"]
    end

    subgraph Hub["Windows PC · WSL 'dash-hub' (Node / TypeScript)"]
        Server["Hub server<br/>WebSocket + /health"]
        Claude["Claude Code<br/>(claude -p)"]
        Jarvis["jarvis MCP"]
        Data[("To-do · deadlines · chats<br/>memory · portfolio")]
        Jobs["Scheduler<br/>brief · sweep · reminders<br/>nightly memory"]
        Ntfy["ntfy server"]
    end

    Mac <-->|"WebSocket over Tailscale"| Server
    App <-->|"WebSocket over Tailscale"| Server
    Server --- Data
    Jobs --> Claude
    Server --> Claude
    Claude --> Jarvis
    Jarvis --> Google[("Gmail · Calendar · Docs")]
    Server --> RH[("Robinhood MCP<br/>read-only")]
    Jobs --> Ntfy -->|push| Push
    Mac <-.->|"Syncthing"| Hub
```

- **Claude runs through Claude Code**, using `claude -p` in headless stream-json mode on the Claude subscription. There's no
  API key. `ANTHROPIC_API_KEY` is stripped from every child environment, so a key set in your shell is never billed.
- **jarvis** is a Python MCP server (`companions/jarvis-mcp`) with 21 tools for Gmail, Calendar, Docs, files, weather,
  web search, a headless browser and lecture recording.
- **Syncthing** keeps Documents, Desktop, Downloads, BrightspaceToDo, `~/.claude/skills` and `~/.dash-shared` (ABOUT_ME)
  the same on the Mac and the hub. Both sides keep 30 days of replaced or deleted files in each folder's `.stversions`
  (Downloads: 14 days). The hub's own data is mirrored back to `~/Dash Backups/hub-data`, with sign-ins and ntfy excluded.
- **While the hub can't be reached**, Today, the to-do list and chats show their last copy read-only. Unpaired,
  Dash runs everything on the Mac.

## Repository layout

| Path | What's there |
|---|---|
| [`Sources/Dash/`](Sources/Dash) | The macOS app (SwiftPM, SwiftUI + AppKit) |
| [`hub/`](hub) | The always-on hub: server, chats, memory, deadlines, notifications, deploy scripts ([README](hub/README.md)) |
| [`mobile/`](mobile) | The iPhone app (Expo / React Native, runs in Expo Go) ([README](mobile/README.md)) |
| [`companions/jarvis-mcp/`](companions/jarvis-mcp) | The jarvis MCP server ([README](companions/jarvis-mcp/README.md)) |
| [`Resources/`](Resources), [`tools/`](tools) | App icon and the script that draws it |
| `build.sh`, `setup.sh` | Build and install the Mac app; set up a new Mac |

<details>
<summary><strong>Mac app code map</strong></summary>

| File | Role |
|---|---|
| `AppDelegate.swift` | Menu bar item, ⌥A / ⌥Space / ⌥L hotkeys, choosing which window to capture |
| `ScreenCapture.swift` | Captures the frontmost window with ScreenCaptureKit and downscales it to ≤1568 px |
| `ClaudeCLI.swift` | One `claude -p` session per conversation. A `ClaudeProfile` sets its tools; calls that aren't pre-approved come back as permission requests for Dash to answer |
| `JarvisClient.swift` | Dash's own jarvis MCP process, called directly over stdio |
| `Personal.swift` | ABOUT_ME, the memory file, and skill loading for console prompts |
| `Prompts.swift` | Lens, console, daily brief and lecture-notes prompts |
| `Usage.swift` | Subscription usage, read from the `rate_limit_event` Claude Code sends with every request |
| `Conversation.swift`, `Session.swift` | A conversation's turns, streaming, tool chips and approvals; the ⌥A lens session |
| `Console/` | The console window and pages: `ChatModel` (saved chats, resume, queue, settings), `TodayModel`, `LectureController`, `MemoryModel` / `MemoryPage`, `Deadlines`, `ToDoList`, and `Toolbox` (the Study buttons) |
| `Hub/` | `HubClient` (pairing, sign-in, reconnect with backoff, heartbeat), `HubConversation`, `HubSettings`, `LectureRemote`, `HubClientCheck` |
| `Portfolio/` | `RobinhoodClient` (OAuth + read-only MCP), `RobinhoodRelay` (read-only MCP for the advisor), `PortfolioModel`, `Analytics`, `PortfolioView` |
| `OverlayPanel.swift`, `OverlayView.swift`, `SettingsView.swift` | The floating panel and Settings |

</details>

## Getting started

### Requirements

- macOS 14 or later, with Xcode Command Line Tools. Xcode itself isn't needed.
- [Claude Code](https://claude.com/claude-code), signed in once by running `claude` in Terminal.
- Python 3.12, for jarvis. For the hub: a Windows PC with WSL2, plus [Tailscale](https://tailscale.com) on every device.

### Mac app

```sh
git clone <this repo> ~/Dash && cd ~/Dash
./setup.sh                 # first time on a new Mac
./build.sh --install       # every build after that
open ~/Applications/Dash.app
```

`setup.sh` installs what Dash needs outside this folder, from `companions/`:
- jarvis, into `~/.claude/mcp-servers/jarvis-mcp`, with its own venv, registered with Claude Code
- any Claude Code skills you put in `companions/skills/` (git-ignored), into `~/.claude/skills`, keeping any that are
  already there. The Study page and `/` in chats list whatever skills are installed.

It then runs `build.sh --install`, and finishes by printing the manual steps.

Secrets are never in the repo:
- the Google credentials and token (`~/.jarvis`)
- the Robinhood login (Keychain)
- `~/ABOUT_ME.md`
- Dash's memory

`build.sh --install` quits a running Dash the way ⌘Q does, so it asks first if a lecture is recording.

### The hub and the phone

The hub's setup, from a bare Windows PC to `deploy.sh`, is in [`hub/README.md`](hub/README.md). The iPhone app's is in
[`mobile/README.md`](mobile/README.md). Once the hub is running, pair this Mac in **Settings › Dash hub**.

### Permissions and signing

- **Microphone:** asked for at the first lecture recording.
- **Screen Recording:** asked for at the first capture (System Settings › Privacy & Security › Screen & System Audio Recording).
- `build.sh` signs with the "Dash Local Signing" certificate in your login keychain, so these permissions survive rebuilds.
  Without that certificate it falls back to ad-hoc signing, and macOS asks again after each build.

## Configuration

Nothing personal is committed. Dash reads it from these untracked files:

| File | Where | Holds |
|---|---|---|
| `~/.dash-shared/profile.json` | Mac (synced to the hub) | Your name, time zone, a crisis-support line, school links and study apps. Every field is optional. |
| `~/ABOUT_ME.md` | Mac (synced to the hub) | Who you are, courses, schedule and writing voice. Injected into every prompt. |
| `~/.config/dash/hub.env` | Hub | `DASH_ALERT_EMAIL` (health alerts) and `DASH_PUBLIC_URL` (your `https://dash-hub.<tailnet>.ts.net`) |
| `build.local` | Repo root (git-ignored) | `DASH_BUNDLE_ID`, your app's bundle identifier (default `com.example.dash`) |

```json
{
  "name": "Alex",
  "fullName": "Alex Doe",
  "timezone": "Eastern",
  "crisisHelp": "your school's counseling center",
  "links": [{ "title": "School email", "subtitle": "Outlook", "icon": "envelope", "url": "https://…" }],
  "studyApps": [{ "title": "Vocab drill", "subtitle": "Spanish", "icon": "character.book.closed", "url": "https://…" }]
}
```

`icon` is an [SF Symbol](https://developer.apple.com/sf-symbols/) name. A study app can use `"file": "~/path/index.html"`
instead of `url`. Secrets (Google and Robinhood sign-ins, device tokens) are created at runtime and never leave the
machine they belong to.

## Using Dash

| Shortcut / control | Does |
|---|---|
| **⌥A** (or the camera button) | Capture the window you're in and answer it |
| **⌥Space** (or ×) | Show or hide the panel |
| **⌥L** (or the window button, or the menu bar icon) | Open or hide the console |
| **Wand button** | Answer, Hint, Explain, or Check My Work on the current capture |
| **Chat field** | Follow-ups about the capture, or anything at all if nothing's captured |
| **Gear** (or ⌘, / menu bar icon) | Settings: model, opacity, the Dash hub |

- The panel stays on top without taking keyboard focus, so you keep typing in your app until you click its chat field.
- Drag the top bar to move the panel and the bottom-right grip to resize it. Its frame is remembered. Right-click the
  top bar, or use Settings › Reset Panel Position, if it ends up off-screen.
- Clicking the Dock icon, or tabbing to Dash, brings the console back. Quit with ⌘Q or the menu bar item.
- **Settings › Dash hub › Open Dash at login** starts Dash when you log in. Quitting mid-lecture asks first.
- Events are logged to `~/Library/Application Support/Dash/dash.log`.

Each console session also gets:
- `~/ABOUT_ME.md`
- Dash's memory: from the hub when paired, otherwise `~/Library/Application Support/Dash/memory.md`. Lines saved
  there while unpaired go to the hub on the next pairing.

Files made with the Study skills go in `~/Documents/Dash`.

Dash keeps its own jarvis process running for Today and Lecture. Recording lives inside that process, so keep Dash
open while a lecture records.

## Security and privacy

- **Robinhood is read-only, in four independent layers:**
  - `RobinhoodClient.call` refuses every tool that isn't on its read-only allowlist (and doesn't start with `get_`),
    before any request is made.
  - The advisor reaches Robinhood through `RobinhoodRelay`, a local MCP server on 127.0.0.1 with a per-launch secret.
    It offers Claude only those read tools, and the Robinhood login never leaves the app.
  - The data loop never goes through Claude, so live prices cost no tokens.
  - There's no order, cancel or edit path, even with Approve or bypassPermissions. (Robinhood's server can trade,
    but only in its separate Agentic account.)
  - Robinhood has no portfolio-history tool, so performance values today's holdings at past daily closes, and the
    chart says so.
- **Chats can't read secrets.** Every Claude session on the hub runs with `Read(//…)` deny rules for its secrets,
  ntfy, the paired-device list, off-the-record chats, `~/.jarvis` and `~/.claude` (except skills). The advisor may
  fetch only `sec.gov`. jarvis's `file_read`/`file_write` refuse the same places, plus key and `.env` files.
- **Off the record means off the record.** Those chats are stored apart, are never summarized, and stay out of memory.
- **The network is tailnet-only.** The hub and ntfy bind to loopback and are published with `tailscale serve`, with no
  funnel. Devices pair with one-time 6-digit codes, and their tokens are stored as hashes.
- **The Claude subscription, not an API key.** API keys are stripped from every child process.

## Testing

```sh
cd hub && npm run check && npm run selftest && npm run portfoliotest   # hub: types + every check, in a throwaway data folder
cd mobile && npx tsc --noEmit                                         # phone app types
swift build                                                           # Mac app
```

The hub's tests never touch the real Documents, ABOUT_ME or memory. `DASH_DATA` moves those paths into a temporary folder.

<details>
<summary><strong>Mac app test hooks</strong></summary>

Run these with the debug binary, and set `DASH_SUPPORT` (plus `DASH_HUB_CREDENTIALS` and `DASH_HUB_CACHE`) to temp
paths, so tests never share the installed app's files.

```sh
Dash --preview out.png [today|chat|lens|lecture|portfolio|portfolio-advisor|study]  # screenshot a console page with sample data
Dash --preview out.png [portfolio-sample|portfolio-sample-bottom]                  # Portfolio with made-up holdings
DASH_PREVIEW_SIZE=720x480 Dash --preview out.png today  # another window size; also prints the page's minimum width
Dash --preview out.png [panel-chat|long|settings]       # the floating panel
Dash --chat-selftest                                    # drives the real chat on Haiku: stop, resume, queue, approvals, history
Dash --jarvis calendar_get '{"days":3}'                 # call a jarvis tool through Dash's client
Dash --ask --console "what's due this week?"            # console chat from the CLI (denies all writes)
Dash --today                                            # load Today for real and write the brief
Dash --hub-pair wss://… 123456                          # pair with a hub (DASH_HUB_CREDENTIALS=file keeps it out of the Keychain)
Dash --hub-import file.json                             # move such a pairing into the Keychain (installed binary)
Dash --hub-check                                        # sign in, load Today, round-trip a to-do through the hub
Dash --hub-memory-check                                 # queue hundreds of memory entries and check each arrives once
Dash --hub-chat-check                                   # drive the Chat page through a (throwaway) hub on Haiku
Dash --robinhood tools|connect|call <tool> '{json}'     # Robinhood client (run the installed app's binary)
Dash --portfolio [advise "question"]                    # analytics self-test + live stats (+ ask the advisor)
Dash --relay-check                                      # relay refuses strangers, lists only reads, blocks orders
```

</details>

## License

[MIT](LICENSE).

## Further reading

- [`hub/README.md`](hub/README.md): memory, deadlines, notifications, the protocol, deploying and operating the hub
- [`mobile/README.md`](mobile/README.md): the iPhone app
- [`companions/jarvis-mcp/README.md`](companions/jarvis-mcp/README.md): jarvis's tools and setup
