# jarvis-mcp

A standalone **MCP (Model Context Protocol) server** that gives any MCP client (Claude Code, Claude Desktop, Dash)
these tools:
- Gmail, Google Calendar and Google Docs
- local files, weather, web search and a headless browser
- lecture recording with local transcription

It's self-contained: there's no external agent framework, and it needs no API key to run. Each tool lights up when its
optional dependency or key is added.

## Tools (21)

**Google: email, calendar and lecture notes in Docs**

| Tool | What it does |
|---|---|
| `email_read` | Read the most recent Gmail inbox messages |
| `email_send` | Send an email from your Gmail account |
| `email_delete` | Move an email to Gmail's Trash, where it's recoverable for 30 days |
| `calendar_get` | Upcoming Google Calendar events within the next N days |
| `calendar_create` | Create an event on your primary calendar |
| `calendar_delete` | Delete an event from your primary calendar |
| `lecture_bootstrap_course` | Create a Drive folder and a Google Doc for a class's running lecture notes |
| `docs_append_notes` | Append notes to a class's lecture-notes Doc |
| `docs_read_section` | Read back one lecture date's notes, or the whole Doc |
| `docs_replace_section` | Replace one lecture date's section with cleaned-up text |

**Lecture recording**

Records the mic in rolling chunks and transcribes them locally with faster-whisper, so audio never leaves the machine.

| Tool | What it does |
|---|---|
| `lecture_start` | Start recording and live-transcribing a lecture for a class |
| `lecture_status` | Whether a recording is active, and how much transcript is unread |
| `lecture_get_new_transcript` | Transcript captured since the last call (advances the checkpoint) |
| `lecture_stop` | Stop recording and return any final unprocessed transcript |

**Everything else**

| Tool | What it does | Optional deps |
|---|---|---|
| `web_search` | Web search: Tavily if `TAVILY_API_KEY` is set, otherwise keyless DuckDuckGo | `ddgs`, `tavily-python` |
| `file_read` | Read txt/md/pdf/docx/csv as text | `pypdf`, `python-docx` |
| `file_write` | Write txt/md/csv, never silently overwriting | — |
| `weather_get` | Current weather and today's forecast (keyless Open-Meteo) | `httpx` |
| `browser_navigate` | Open a URL in headless Chromium and return its text | `playwright` |
| `browser_interact` | Click or fill on the open page | `playwright` |
| `browser_screenshot` | Screenshot the page, returned as an MCP image | `playwright` |

The Google tools need `google-api-python-client`, `google-auth-oauthlib` and `google-auth-httplib2`. Lecture recording
also needs `faster-whisper` and `sounddevice`, which aren't in `requirements.txt`.

## How it's wired

- `app.py` creates the single `FastMCP("jarvis")` instance and loads `.env`.
- Each module in `jarvis_tools/` does `from app import mcp` and registers its tools. Blocking tools use the
  `tool_threaded` wrapper, so a slow call never stalls the event loop. That includes the first-run Google consent flow.
- `server.py` imports those modules, which registers them, and runs over **stdio**.
- Optional dependencies are imported defensively: a missing package disables only its own tool, which returns a setup
  hint, instead of crashing the server.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\activate
pip install -r requirements.txt
```

Register it with Claude Code, adjusting the paths to where you cloned this repo:

```bash
claude mcp add jarvis -s user -- /path/to/jarvis-mcp/.venv/bin/python /path/to/jarvis-mcp/server.py
# Windows:
# claude mcp add jarvis -s user -- C:\path\to\jarvis-mcp\.venv\Scripts\python.exe C:\path\to\jarvis-mcp\server.py
```

Manage it with `claude mcp get jarvis`, `claude mcp list` and `claude mcp remove jarvis -s user`.

### Optional configuration

Copy `.env.example` to `.env` and set what you want. All of it is optional.

| Variable | Effect |
|---|---|
| `TAVILY_API_KEY` | Better web search than the keyless default |
| `WEATHER_UNITS`, `WEATHER_LOCATION` | `fahrenheit` / `celsius`, and a fixed city |
| `GOOGLE_CREDENTIALS_PATH`, `GOOGLE_TOKEN_PATH` | Default to `~/.jarvis/` |
| `JARVIS_HEADLESS=1` | Never open a browser for Google sign-in; fail fast with re-auth steps instead (automatic on Linux with no display) |

### Enable email, calendar and Docs

1. Create an OAuth 2.0 Client ID (Desktop app) in Google Cloud Console.
2. Enable the Gmail, Calendar, Drive and Docs APIs.
3. Download the client-secrets JSON to `~/.jarvis/credentials.json`.

The first Google call opens a browser to authorize once, and the token is cached. After a re-auth, running servers pick
up the new token by themselves, with no restart. On a headless machine, sign in on a computer with a browser and copy
`google_token.json` over.

### Enable the browser tools

```bash
python -m playwright install chromium
```

## Security

`file_read` and `file_write` refuse secrets, checking the path both as written and after resolving symlinks and `..`:
- `~/.jarvis`, `~/.claude`, `~/.ssh` and `~/Library/Keychains`
- Dash's `secrets/` and `ntfy/`
- `.env`, `*.pem`, `*.key` and `client_secret*.json` files

## Notes and known limitations

- **stdout is reserved for the MCP protocol.** All logging goes to stderr, so never `print()` to stdout in a tool.
- The browser tools need a one-time `playwright install chromium`. On Windows, Playwright may print a harmless
  `Event loop is closed` message when the server exits.
- After changing tool code, restart your MCP client so it relaunches the server.
- Tests: `pytest tests/`.

## License

MIT
