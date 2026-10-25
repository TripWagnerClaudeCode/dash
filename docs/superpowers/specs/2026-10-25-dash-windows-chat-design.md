# Dash for Windows — Chat (v1) Design

**Date:** 2026-10-25
**Status:** Approved (brainstorming) — ready for implementation planning
**Scope:** First slice of a Windows rewrite of Dash: a native Chat console backed by Claude Code.

## Background

Dash is a personal AI console, currently a **native macOS app** (Swift + SwiftUI/AppKit + ScreenCaptureKit + Carbon + Keychain). It cannot run on Windows: its entire UI and system-integration layer is Apple-only, and the Windows Swift toolchain ships no AppKit/SwiftUI/ScreenCaptureKit. Porting means a ground-up rewrite in a Windows-capable UI stack, not a recompile.

The macOS app is six subsystems sharing one shell: the **lens** (⌥A screen-capture overlay) and a console with **Today**, **Chat**, **Lecture**, **Portfolio**, and **Study**. Rebuilding all of it at once would be an unwieldy spec. This document scopes **only the first slice**: Chat, plus the shared foundation (window shell + Claude integration layer) that the other five pages will reuse.

Chat is deliberately first: it exercises the hardest shared plumbing — driving `claude -p` in streaming stream-json mode and handling permission-approval round-trips — so every later page is easier once it works.

## Decisions

- **Feature first:** Chat.
- **UI stack:** **Avalonia** (C#/.NET, XAML, MVVM). Chosen for: modern Fluent look, strong data-binding for streaming UI, mature libraries for the rich chat UI (`Markdown.Avalonia`) and later pages (`LiveCharts2`), clean C# child-process/streaming story, and — uniquely among the candidates — cross-platform, so this codebase could eventually run on the Mac and *replace* the Swift app rather than fork it. It is a genuinely native compiled desktop app (not a browser/WebView), though it renders its own controls via Skia rather than using raw Win32 widgets. Rejected: Tauri/Electron (both render UI in a browser engine); WPF (Windows-only, dated); WinUI 3 (rougher tooling, thinner ecosystem for markdown/charts).
- **Backend:** the local `claude.exe` (already at `%USERPROFILE%\.local\bin\claude.exe`), driven exactly as the macOS `ClaudeCLI.swift` drives it. Uses the signed-in Claude Code subscription; API-key env vars are stripped from the child process.
- **jarvis MCP tools:** **deferred** to a later slice (they require installing the Python jarvis MCP server locally). v1 uses Claude Code's built-in tools only.

## v1 Scope

**In v1:**
- Streaming replies rendered as markdown (tables, fenced code blocks with a copy button).
- Tool-call chips that expand to show command / diff / output.
- **Approve/Deny cards** with the full command or diff, plus "Always allow for this chat" (session-scoped, never written to settings files). *The hard part, and the reason Chat goes first.*
- Claude Code built-in tools: `Read / Glob / Grep / WebSearch` run freely; `Bash / Edit / Write / WebFetch` route through approval.
- Saved chats: history list, rename, delete, and **resume with full context** via `--resume`.
- Composer: Return to send / Shift-Return newline, queue messages while a turn is active, Stop/interrupt.
- Per-chat menu: model + effort + permission mode.

**Deferred (explicitly out of v1):**
- jarvis tools (calendar / email / Docs) and the Python MCP server install.
- Image/file paste-and-drop into the composer.
- `/` skill listing in the composer.
- "remember…" → memory file.
- Console system-prompt personalization (`ABOUT_ME.md` / `memory.md` / skills). v1 uses a simpler system prompt.
- The other five pages (Today, Lecture, Portfolio, Study) and the lens overlay.

## Architecture & Component Boundaries

Three layers. Layers 1–2 have **no Avalonia dependency**, so the Claude protocol and chat logic are unit-testable headlessly and reusable on the Mac later. Layer 1 is a near-direct port of `ClaudeCLI.swift`.

### Layer 1 — Claude integration (pure .NET, no UI)

- **`ClaudeSession`** — owns one `claude.exe` child process launched with
  `-p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --model <id> …`.
  Writes user messages and permission decisions to stdin; reads newline-delimited JSON from stdout and emits a typed event stream.
  Public surface:
  - `SendAsync(content, onEvent) -> TurnResult`
  - `Respond(request, allow, always)`
  - `Interrupt() -> bool`
  - `Close()`
  Constructed with: model, effort, system prompt, `ClaudeProfile`, optional session-id, resume flag.
  Strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` and sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on the child env, like Dash. Runs in an empty working directory so no project `CLAUDE.md` is pulled in. Uses `--strict-mcp-config --setting-sources ""` so the child loads nothing beyond what the profile names.
  Depends only on .NET process APIs + the data types below.
- **Data types** (plain records, no dependencies): `ClaudeModel`, `ClaudeProfile` (tool lists, allowed/disallowed, permission mode, add-dirs), `PermissionRequest`, `ClaudeEvent` (`Text` / `Thinking` / `ToolStarted` / `ToolFinished` / `Permission`), `TurnResult`.

### Layer 2 — Chat domain (view-models + persistence, no Avalonia specifics)

- **`ChatConversation`** — one chat's state: ordered turns, the in-flight streaming assistant message, the queued-message list, the pending approval, and per-chat settings (model / effort / permission mode). Drives a `ClaudeSession`; exposes send / enqueue / stop / approve / deny. Port of `ChatModel.swift` + `Conversation.swift`.
- **`ChatStore`** — persistence under `%APPDATA%\Dash\chats\`. `List / Load / Save / Rename / Delete`. Resume = hand the stored session-id to a new `ClaudeSession` with `--resume`.

### Layer 3 — UI (Avalonia XAML + MVVM)

- **`MainWindow` shell** — left sidebar + content area. Thin on purpose: one nav item (Chat) now; the other pages slot in later without reworking the shell.
- **Chat UI pieces**, each small and focused:
  - `ChatListView` — saved-chat history, new / rename / delete.
  - `ChatView` — transcript + composer + settings menu + Stop.
  - `MessageView` — markdown via `Markdown.Avalonia`, code blocks with a copy button.
  - `ToolChipView` — collapsible tool call (command / diff / output).
  - `ApprovalCardView` — command/diff + Approve / Deny / Always allow.
  - `ComposerView` — multiline input, Return / Shift-Return, queue indicator.

## Data Flow

### Sending a message (streaming turn)

1. User presses Return. `ChatConversation` appends a user turn and an empty assistant turn marked "streaming."
2. If no `ClaudeSession` exists for this chat, create one (model/effort/profile/system prompt, fresh `--session-id <uuid>`). Otherwise reuse the open session so follow-ups send only the new message.
3. `SendAsync` writes one `{"type":"user","message":{…}}` line to stdin and awaits the turn.
4. Stdout events mutate the assistant turn live:
   - `text_delta` → append to assistant text (UI re-renders markdown incrementally).
   - `thinking_delta` → append to a collapsible thinking section.
   - `tool_use` (assistant block) → add a `ToolChip` in "running" state.
   - `tool_result` (user block) → mark chip finished, store output (truncated ~30k, like Dash).
   - `rate_limit_event` → ignored in v1 (feeds Today later).
   - `result` → finalize the assistant turn; persist the chat.

### Permission approval round-trip

- A `control_request` with `subtype: can_use_tool` for a non-pre-approved tool (`Bash`/`Edit`/`Write`/`WebFetch`) becomes a `PermissionRequest`. `ChatConversation` sets `PendingApproval`; the UI shows an `ApprovalCardView`; the turn **pauses** (the `claude.exe` turn is genuinely blocked awaiting our `control_response`).
- **Approve** → `control_response` `behavior: allow` (+ suggested allow-rule rewritten to `destination: "session"` if "Always allow" chosen).
- **Deny** → `behavior: deny` with a message so Claude explains itself.
- "Always allow" is **session-scoped only** and never written to any Claude settings file. We keep only narrow `addRules`+`allow` suggestions (drop mode changes and whole-directory grants), matching Dash.
- Unsupported control requests (hooks, MCP elicitation) get an error `control_response` so `claude.exe` never hangs.

### Queue & interrupt

- Messages typed while a turn is active go into `ChatConversation`'s queue and flush in order when the turn ends.
- Stop issues an `interrupt` control request; the turn ends flagged interrupted; the session stays alive with its context; queued messages still flush.

## Persistence

- **Claude Code owns the conversation context** (keyed by session-id, replayed via `--resume`). We never store history *for the model*.
- **We own the rendered transcript + metadata**, under `%APPDATA%\Dash\chats\`:
  - `index.json` — chat list: `{ id, title, claudeSessionId, createdAt, updatedAt, model, effort, permissionMode }` per chat.
  - `<chat-id>.json` — that chat's display transcript (user/assistant text, tool chips with inputs/outputs, resolved approvals) so the window repaints instantly on launch without calling Claude.
- **Resume flow:** on relaunch, the sidebar loads from `index.json` (instant); opening a chat repaints from `<chat-id>.json`; the `ClaudeSession` is created lazily on the next send with `--resume <claudeSessionId>` (no process spawned just by clicking around).
- Title auto-set from the first user message (editable). Transcript writes are debounced so disk isn't hammered mid-stream.

## Error Handling

Guiding rule: **a chat never silently dies or lies about state.** Every failure ends in a visible, recoverable UI state; anything streaming is finalized, not left spinning.

- **CLI not found / not signed in.** Resolve `claude.exe` via `%USERPROFILE%\.local\bin\claude.exe` then `PATH`. Missing → clear "Claude Code isn't installed / on PATH" message. Login markers in stderr (`/login`, `not logged in`, `authenticat`, `oauth`, `invalid api key`) → "Claude Code isn't signed in. Run `claude` in a terminal and log in, then try again."
- **Process dies mid-turn.** `SendAsync` completes as failure; the streaming turn is finalized with an inline error banner (+ capped stderr tail); composer re-enables; session marked dead so the next send transparently respawns with `--resume` (context intact).
- **Malformed / partial stdout.** Parse per newline; unparseable lines logged and skipped; partial lines buffer until their newline. Never crashes the reader.
- **Turn-level results.** Non-interrupt `result is_error:true` → inline error on that turn, composer re-enables, queue preserved. Interrupt-flagged error → shown as "stopped," not an error.
- **Permission edge cases.** If an approval card is pending and the process dies, the card is dismissed and the turn errors cleanly.
- **Persistence failures.** Failed write → logged + small non-blocking "couldn't save" indicator, never interrupts the live turn. Corrupt `index.json`/`<chat-id>.json` on load → quarantined (renamed `.corrupt`) and skipped.
- **Interrupt timing.** Stop sends interrupt; if ignored, `Close()` falls back to terminate-then-kill after a short grace (Dash's SIGTERM→SIGKILL pattern via .NET `Process.Kill`).
- **Logging.** Exits, parse errors, login failures, kill fallbacks append to `%APPDATA%\Dash\dash.log`.

## Testing

Framework: **xUnit**, in a `Dash.Tests` project. Layers 1–2 are UI-free, so most of the value is covered headlessly.

1. **Protocol unit tests (`ClaudeSession` parsing) — highest value.** Feed canned newline-delimited JSON (captured from a real run), assert the exact `ClaudeEvent` sequence: text assembly; thinking block; `tool_use`→`tool_result` with ~30k truncation; `control_request can_use_tool` → `PermissionRequest` keeping only narrow session-scoped allow suggestions; `result` success and `is_error`; interrupt-flagged error → "stopped" not failed; split/partial line buffering; unparseable line skipped without throwing.
2. **Approval-logic tests.** Given a `PermissionRequest`, assert exact `control_response` JSON for allow / deny / allow-with-always (always attaches only `addRules`+`allow` rewritten to `destination: "session"`; deny carries the explain-why message).
3. **Persistence tests (`ChatStore`).** Save→Load round-trip equality; rename/delete mutate `index.json` correctly; corrupt file quarantined to `.corrupt` and skipped; writes debounced. Runs against a temp directory.
4. **Fake-CLI integration test.** A tiny stub console executable speaks the stream-json protocol (reads a stdin line, emits scripted stdout events, blocks on a permission request until it gets a `control_response`). `ClaudeSession` points at the stub instead of `claude.exe`, exercising the real child-process + stdin/stdout + async-reader path deterministically and offline — covering queue, interrupt, and approve/deny round-trips without tokens or network.
5. **Real end-to-end self-test (opt-in),** ported from Dash's `--chat-selftest`: `Dash.exe --chat-selftest` drives a real Haiku session through send → stream → stop → resume → queue → approval → save/reload. Not in CI (needs a signed-in CLI, burns a little quota); it is the acceptance test for "is Chat actually usable on Windows."
6. **Manual UI smoke (documented checklist, not automated):** markdown/code-block rendering, code-block copy, tool chip expand, approval card with a real diff, Return vs Shift-Return, queue while streaming, Stop, relaunch-and-resume.

## Open Items to Verify During Implementation (not assumed)

- That `--session-id` / `--resume` behave identically on the installed Windows `claude.exe` (expected — core Claude Code behavior).
- The exact `--model` strings the local CLI accepts. Use the `opus` / `sonnet` / `haiku` **aliases** in the model picker rather than hardcoding version IDs, so it stays correct across CLI versions.
- Whether the installed `.NET SDK` is present / which version (confirm before scaffolding the Avalonia solution).
- Windows child-process stdin/stdout stream behavior under load (line buffering, async reads) against the fake CLI before wiring the real one.

## Out of Scope / Future Slices

In rough intended order after Chat: **jarvis MCP integration** (unlocks calendar/email/Docs and the richer console system prompt) → **Today** → **Study** → **Portfolio** → **Lecture** → **lens overlay** (the most Windows-specific: screen capture + global hotkeys). Each future slice gets its own spec → plan → implementation cycle, reusing Layer 1 (`ClaudeSession`) and the Layer 3 shell built here.
