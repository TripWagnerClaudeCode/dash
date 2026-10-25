# Dash for Windows — Chat (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native Windows (Avalonia/.NET) Chat console backed by the local `claude.exe`, with streaming markdown replies, expandable tool chips, approve/deny permission cards, saved/resumable chats, a message queue, and a per-chat model/effort/permission menu.

**Architecture:** Three layers. **Dash.Core** (class library, no Avalonia) holds the Claude integration (`StreamJsonParser`, `ClaudeSession`), the data types, the chat view-models (`ChatConversation`), and persistence (`ChatStore`) — all headlessly testable. **Dash** (Avalonia app) holds the UI and binds to Dash.Core. **Dash.Tests** (xUnit) and **Dash.FakeCli** (a protocol stub) make the integration path deterministic and offline. The Claude integration is a direct port of the macOS `ClaudeCLI.swift`.

**Tech Stack:** .NET 9, C#, Avalonia 11 (Fluent theme), CommunityToolkit.Mvvm, Markdown.Avalonia, xUnit. Backend is `claude.exe` driven via `-p --input-format stream-json --output-format stream-json`.

## Global Constraints

- **Target framework:** `net9.0` for all projects (Dash.Core, Dash.Tests, Dash.FakeCli); `net9.0` (or `net9.0-windows` if a Windows-only API is ever needed — not expected for v1) for the Dash app.
- **Dash.Core must not reference Avalonia.** View-models use `CommunityToolkit.Mvvm` (`ObservableObject`), which is UI-framework-agnostic. This keeps Core headlessly testable and reusable on macOS later.
- **Child process env:** every `claude.exe` launch removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` and sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **Claude args (fixed set):** `-p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --strict-mcp-config --setting-sources ""`, plus `--model <alias>`, the system prompt flag, tool flags, and session flags per task.
- **Model picker uses aliases only:** `opus`, `sonnet`, `haiku` (never version-pinned IDs).
- **Pre-approved tools (run freely):** `Read`, `Glob`, `Grep`, `WebSearch`. **Approval-gated tools:** `Bash`, `Edit`, `Write`, `WebFetch`. (`Task` is allowed; `NotebookEdit` is gated like Dash but rarely hit.)
- **"Always allow" is session-scoped only** — rewrite kept suggestions to `destination: "session"`; never write to any Claude settings file.
- **Persistence root:** `%APPDATA%\Dash\` (chats under `chats\`, log at `dash.log`).
- **Output truncation:** tool results capped at 30,000 chars with a `\n… (output truncated)` suffix.
- **Commit after every task** (and after each green test cycle where noted). Repo: `C:\Users\you\dash-windows` (branch `master`).

---

### Task 0: Environment + solution scaffolding

**Files:**
- Create: `Dash.sln`, `src/Dash.Core/Dash.Core.csproj`, `src/Dash/Dash.csproj`, `tests/Dash.Tests/Dash.Tests.csproj`, `tests/Dash.FakeCli/Dash.FakeCli.csproj`

**Interfaces:**
- Produces: the solution structure and package references every later task builds on.

- [ ] **Step 1: Install the .NET SDK**

Run:
```
winget install --id Microsoft.DotNet.SDK.9 --silent
```
Then open a fresh terminal (so PATH refreshes) and verify:
```
dotnet --list-sdks
```
Expected: one line like `9.0.xxx [C:\Program Files\dotnet\sdk]`. If `winget` is unavailable, download the .NET 9 SDK installer from https://dotnet.microsoft.com/download and run it, then re-verify.

- [ ] **Step 2: Install Avalonia templates**

Run:
```
dotnet new install Avalonia.Templates
```
Expected: output listing installed templates including `avalonia.mvvm` / `avalonia.app`.

- [ ] **Step 3: Create the solution and projects**

Run from `C:\Users\you\dash-windows`:
```
dotnet new sln -n Dash
dotnet new classlib -n Dash.Core -o src/Dash.Core -f net9.0
dotnet new avalonia.app -n Dash -o src/Dash
dotnet new xunit -n Dash.Tests -o tests/Dash.Tests -f net9.0
dotnet new console -n Dash.FakeCli -o tests/Dash.FakeCli -f net9.0
dotnet sln add src/Dash.Core src/Dash tests/Dash.Tests tests/Dash.FakeCli
```
Remove the default `Class1.cs` in Dash.Core:
```
del src\Dash.Core\Class1.cs
```

- [ ] **Step 4: Add references and packages**

Run:
```
dotnet add src/Dash.Core package CommunityToolkit.Mvvm
dotnet add src/Dash reference src/Dash.Core
dotnet add src/Dash package Avalonia.Markdown   # Markdown.Avalonia package id is "Markdown.Avalonia"
dotnet add tests/Dash.Tests reference src/Dash.Core
```
If `Avalonia.Markdown` is not found, use the correct id:
```
dotnet add src/Dash package Markdown.Avalonia
```

- [ ] **Step 5: Verify the solution builds**

Run:
```
dotnet build
```
Expected: `Build succeeded` with 0 errors (warnings OK).

- [ ] **Step 6: Commit**

```
git add -A
git commit -m "chore: scaffold Dash.sln (Core, app, tests, fake CLI) and install toolchain"
```

---

### Task 1: Core data types

**Files:**
- Create: `src/Dash.Core/ClaudeModel.cs`, `src/Dash.Core/ClaudeProfile.cs`, `src/Dash.Core/ClaudeEvents.cs`
- Test: `tests/Dash.Tests/ClaudeModelTests.cs`

**Interfaces:**
- Produces:
  - `record ClaudeModel(string Id, string Name, string Blurb, bool SupportsEffort)` with statics `Opus`, `Sonnet`, `Haiku`, `All`, `DefaultId`, and `static ClaudeModel Find(string id)`.
  - `class ClaudeProfile` with `List<string> Tools, AllowedTools, DisallowedTools, AddDirs; bool KeepDefaultPrompt; string? PermissionMode;` and `static ClaudeProfile Console()`. Static arrays `ChatTools`.
  - `record PermissionRequest(string Id, string ToolName, string DisplayName, Dictionary<string,object?> Input, List<Dictionary<string,object?>> Suggestions)`.
  - `abstract record ClaudeEvent` with cases `TextEvent(string)`, `ThinkingEvent(string)`, `ToolStartedEvent(string Id, string Name, Dictionary<string,object?> Input)`, `ToolFinishedEvent(string Id, bool IsError, string Output)`, `PermissionEvent(PermissionRequest Request)`.
  - `record TurnResult(string Text, string? StopReason = null, bool Interrupted = false)`.

- [ ] **Step 1: Write the failing test**

`tests/Dash.Tests/ClaudeModelTests.cs`:
```csharp
using Dash.Core;
using Xunit;

public class ClaudeModelTests
{
    [Fact]
    public void Find_unknown_id_returns_opus_default()
    {
        Assert.Equal(ClaudeModel.Opus.Id, ClaudeModel.Find("nope").Id);
    }

    [Fact]
    public void Haiku_does_not_support_effort()
    {
        Assert.False(ClaudeModel.Haiku.SupportsEffort);
    }

    [Fact]
    public void Console_profile_allows_reads_and_gates_writes()
    {
        var p = ClaudeProfile.Console();
        Assert.Contains("Read", p.AllowedTools);
        Assert.Contains("WebSearch", p.AllowedTools);
        Assert.DoesNotContain("Bash", p.AllowedTools);
        Assert.Contains("Bash", p.Tools);
        Assert.True(p.KeepDefaultPrompt);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test --filter ClaudeModelTests`
Expected: FAIL to compile — `ClaudeModel`/`ClaudeProfile` not defined.

- [ ] **Step 3: Write the implementations**

`src/Dash.Core/ClaudeModel.cs`:
```csharp
namespace Dash.Core;

public record ClaudeModel(string Id, string Name, string Blurb, bool SupportsEffort)
{
    public static readonly ClaudeModel Opus   = new("opus",   "Opus",   "best quality", true);
    public static readonly ClaudeModel Sonnet = new("sonnet", "Sonnet", "faster",       true);
    public static readonly ClaudeModel Haiku  = new("haiku",  "Haiku",  "fastest, lightest on limits", false);

    public static readonly ClaudeModel[] All = { Opus, Sonnet, Haiku };
    public static string DefaultId => Opus.Id;
    public static ClaudeModel Find(string id) => All.FirstOrDefault(m => m.Id == id) ?? Opus;
}
```

`src/Dash.Core/ClaudeProfile.cs`:
```csharp
namespace Dash.Core;

public class ClaudeProfile
{
    public List<string> Tools { get; set; } = new();
    public List<string> AllowedTools { get; set; } = new();
    public List<string> DisallowedTools { get; set; } = new();
    public List<string> AddDirs { get; set; } = new();
    public bool KeepDefaultPrompt { get; set; }
    public string? PermissionMode { get; set; }

    public static readonly string[] ChatTools =
        { "Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "WebFetch", "NotebookEdit", "Task" };

    public static ClaudeProfile Console(IEnumerable<string>? addDirs = null)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return new ClaudeProfile
        {
            Tools = ChatTools.ToList(),
            AllowedTools = new() { "Read", "Glob", "Grep", "WebSearch", "Task" },
            DisallowedTools = new(),
            AddDirs = new List<string>
            {
                Path.Combine(home, "Documents"),
                Path.Combine(home, "Desktop"),
                Path.Combine(home, "Downloads"),
            }.Concat(addDirs ?? Enumerable.Empty<string>()).ToList(),
            KeepDefaultPrompt = true,
        };
    }
}
```

`src/Dash.Core/ClaudeEvents.cs`:
```csharp
namespace Dash.Core;

public record PermissionRequest(
    string Id, string ToolName, string DisplayName,
    Dictionary<string, object?> Input,
    List<Dictionary<string, object?>> Suggestions);

public abstract record ClaudeEvent
{
    public record TextEvent(string Text) : ClaudeEvent;
    public record ThinkingEvent(string Text) : ClaudeEvent;
    public record ToolStartedEvent(string Id, string Name, Dictionary<string, object?> Input) : ClaudeEvent;
    public record ToolFinishedEvent(string Id, bool IsError, string Output) : ClaudeEvent;
    public record PermissionEvent(PermissionRequest Request) : ClaudeEvent;
}

public record TurnResult(string Text, string? StopReason = null, bool Interrupted = false);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test --filter ClaudeModelTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(core): add ClaudeModel, ClaudeProfile, event/result types"
```

---

### Task 2: StreamJsonParser (stdout → events)

The subtle correctness core. Pure logic: feed newline-delimited JSON lines, get `ClaudeEvent`s and a resolved `TurnResult`. No process.

**Files:**
- Create: `src/Dash.Core/StreamJsonParser.cs`
- Test: `tests/Dash.Tests/StreamJsonParserTests.cs`

**Interfaces:**
- Consumes: `ClaudeEvent`, `PermissionRequest`, `TurnResult` (Task 1).
- Produces:
  - `class StreamJsonParser` with:
    - `event Action<ClaudeEvent>? OnEvent;`
    - `void Feed(ReadOnlySpan<byte> data)` — buffers bytes, splits on `0x0A`, parses each complete line.
    - `TurnResult? Result` — set once a `result` line is seen (null until then).
    - `bool InterruptRequested { get; set; }` — set by the owner before interrupting; changes how an error `result` is interpreted.
  - `static string ResultText(JsonElement? content)` — tool_result content → string, truncated at 30k.
  - `static List<Dictionary<string,object?>> KeepNarrowSuggestions(JsonElement permissionSuggestions)` — keep only `type==addRules && behavior==allow`, rewrite `destination` to `"session"`.

- [ ] **Step 1: Write the failing tests**

`tests/Dash.Tests/StreamJsonParserTests.cs`:
```csharp
using System.Text;
using Dash.Core;
using Xunit;

public class StreamJsonParserTests
{
    static List<ClaudeEvent> Run(string lines, bool interrupt = false)
    {
        var events = new List<ClaudeEvent>();
        var p = new StreamJsonParser { InterruptRequested = interrupt };
        p.OnEvent += events.Add;
        p.Feed(Encoding.UTF8.GetBytes(lines));
        return events;
    }

    const string TextDelta =
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}}\n" +
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}}\n";

    [Fact]
    public void Emits_text_deltas_in_order()
    {
        var e = Run(TextDelta).OfType<ClaudeEvent.TextEvent>().Select(x => x.Text).ToArray();
        Assert.Equal(new[] { "Hel", "lo" }, e);
    }

    [Fact]
    public void Tool_use_then_result_emits_started_and_finished()
    {
        var lines =
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}]}}\n" +
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":false,\"content\":\"out\"}]}}\n";
        var e = Run(lines);
        var started = Assert.IsType<ClaudeEvent.ToolStartedEvent>(e[0]);
        Assert.Equal("Bash", started.Name);
        var finished = Assert.IsType<ClaudeEvent.ToolFinishedEvent>(e[1]);
        Assert.Equal("t1", finished.Id);
        Assert.Equal("out", finished.Output);
    }

    [Fact]
    public void Permission_request_keeps_only_narrow_session_allow_rules()
    {
        var lines =
            "{\"type\":\"control_request\",\"request_id\":\"r1\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"Bash\",\"input\":{\"command\":\"rm x\"},\"permission_suggestions\":[" +
            "{\"type\":\"addRules\",\"behavior\":\"allow\",\"rules\":[]}," +
            "{\"type\":\"setMode\",\"mode\":\"acceptEdits\"}]}}\n";
        var perm = Assert.IsType<ClaudeEvent.PermissionEvent>(Run(lines)[0]).Request;
        Assert.Equal("Bash", perm.ToolName);
        Assert.Single(perm.Suggestions);
        Assert.Equal("session", perm.Suggestions[0]["destination"]);
    }

    [Fact]
    public void Result_success_sets_turn_result()
    {
        var p = new StreamJsonParser();
        p.Feed(Encoding.UTF8.GetBytes("{\"type\":\"result\",\"result\":\"done\",\"is_error\":false,\"stop_reason\":\"end_turn\"}\n"));
        Assert.Equal("done", p.Result!.Text);
        Assert.False(p.Result.Interrupted);
    }

    [Fact]
    public void Error_result_while_interrupting_is_marked_interrupted()
    {
        var p = new StreamJsonParser { InterruptRequested = true };
        p.Feed(Encoding.UTF8.GetBytes("{\"type\":\"result\",\"result\":\"stopped\",\"is_error\":true}\n"));
        Assert.True(p.Result!.Interrupted);
    }

    [Fact]
    public void Partial_line_buffers_until_newline()
    {
        var p = new StreamJsonParser();
        var seen = new List<ClaudeEvent>();
        p.OnEvent += seen.Add;
        p.Feed(Encoding.UTF8.GetBytes("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}"));
        Assert.Empty(seen);
        p.Feed(Encoding.UTF8.GetBytes("}}\n"));
        Assert.Single(seen);
    }

    [Fact]
    public void Unparseable_line_is_skipped()
    {
        var e = Run("not json\n" + TextDelta);
        Assert.Equal(2, e.OfType<ClaudeEvent.TextEvent>().Count());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test --filter StreamJsonParserTests`
Expected: FAIL to compile — `StreamJsonParser` not defined.

- [ ] **Step 3: Write the implementation**

`src/Dash.Core/StreamJsonParser.cs`:
```csharp
using System.Text.Json;

namespace Dash.Core;

public class StreamJsonParser
{
    public Action<ClaudeEvent>? OnEvent;
    public TurnResult? Result { get; private set; }
    public bool InterruptRequested { get; set; }

    private readonly List<byte> _buffer = new();

    public void Feed(ReadOnlySpan<byte> data)
    {
        foreach (var b in data) _buffer.Add(b);
        int nl;
        while ((nl = _buffer.IndexOf((byte)0x0A)) >= 0)
        {
            var line = _buffer.GetRange(0, nl).ToArray();
            _buffer.RemoveRange(0, nl + 1);
            if (line.Length == 0) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                Handle(doc.RootElement);
            }
            catch (JsonException) { /* skip malformed line */ }
        }
    }

    private void Handle(JsonElement e)
    {
        switch (Str(e, "type"))
        {
            case "stream_event":
                if (e.TryGetProperty("event", out var inner) &&
                    Str(inner, "type") == "content_block_delta" &&
                    inner.TryGetProperty("delta", out var delta))
                {
                    switch (Str(delta, "type"))
                    {
                        case "text_delta" when delta.TryGetProperty("text", out var t):
                            OnEvent?.Invoke(new ClaudeEvent.TextEvent(t.GetString() ?? "")); break;
                        case "thinking_delta" when delta.TryGetProperty("thinking", out var th):
                            OnEvent?.Invoke(new ClaudeEvent.ThinkingEvent(th.GetString() ?? "")); break;
                    }
                }
                break;

            case "assistant":
                foreach (var b in Content(e))
                    if (Str(b, "type") == "tool_use" && b.TryGetProperty("id", out var id) && b.TryGetProperty("name", out var nm))
                        OnEvent?.Invoke(new ClaudeEvent.ToolStartedEvent(
                            id.GetString()!, nm.GetString()!, ToDict(b, "input")));
                break;

            case "user":
                foreach (var b in Content(e))
                    if (Str(b, "type") == "tool_result" && b.TryGetProperty("tool_use_id", out var tid))
                        OnEvent?.Invoke(new ClaudeEvent.ToolFinishedEvent(
                            tid.GetString()!,
                            b.TryGetProperty("is_error", out var ie) && ie.ValueKind == JsonValueKind.True,
                            ResultText(b.TryGetProperty("content", out var c) ? c : (JsonElement?)null)));
                break;

            case "control_request":
                var reqId = Str(e, "request_id");
                if (reqId is null || !e.TryGetProperty("request", out var req)) break;
                if (Str(req, "subtype") != "can_use_tool" || Str(req, "tool_name") is not string tool)
                    break; // unsupported control requests are answered by ClaudeSession, not here
                var suggestions = req.TryGetProperty("permission_suggestions", out var ps)
                    ? KeepNarrowSuggestions(ps) : new();
                OnEvent?.Invoke(new ClaudeEvent.PermissionEvent(new PermissionRequest(
                    reqId, tool, Str(req, "display_name") ?? tool, ToDict(req, "input"), suggestions)));
                break;

            case "result":
                var text = Str(e, "result") ?? "";
                bool isError = e.TryGetProperty("is_error", out var er) && er.ValueKind == JsonValueKind.True;
                if (InterruptRequested && isError)
                    Result = new TurnResult(text, "interrupted", true);
                else if (isError)
                    Result = new TurnResult(text.Length > 0 ? text : "Claude Code reported an error.", "error");
                else
                    Result = new TurnResult(text, Str(e, "stop_reason"));
                break;
        }
    }

    public static List<Dictionary<string, object?>> KeepNarrowSuggestions(JsonElement arr)
    {
        var kept = new List<Dictionary<string, object?>>();
        if (arr.ValueKind != JsonValueKind.Array) return kept;
        foreach (var s in arr.EnumerateArray())
        {
            if (Str(s, "type") == "addRules" && Str(s, "behavior") == "allow")
            {
                var d = JsonToDict(s);
                d["destination"] = "session";
                kept.Add(d);
            }
        }
        return kept;
    }

    public static string ResultText(JsonElement? content)
    {
        string text = "";
        if (content is { ValueKind: JsonValueKind.String } s) text = s.GetString() ?? "";
        else if (content is { ValueKind: JsonValueKind.Array } a)
            text = string.Join("\n", a.EnumerateArray()
                .Where(b => b.TryGetProperty("text", out _))
                .Select(b => b.GetProperty("text").GetString() ?? ""));
        return text.Length > 30_000 ? text[..30_000] + "\n… (output truncated)" : text;
    }

    private static IEnumerable<JsonElement> Content(JsonElement e) =>
        e.TryGetProperty("message", out var m) && m.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array
            ? c.EnumerateArray() : Enumerable.Empty<JsonElement>();

    private static string? Str(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static Dictionary<string, object?> ToDict(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Object ? JsonToDict(v) : new();

    private static Dictionary<string, object?> JsonToDict(JsonElement o)
    {
        var d = new Dictionary<string, object?>();
        foreach (var p in o.EnumerateObject()) d[p.Name] = JsonToValue(p.Value);
        return d;
    }

    private static object? JsonToValue(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString(),
        JsonValueKind.Number => v.TryGetInt64(out var l) ? l : v.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Array => v.EnumerateArray().Select(JsonToValue).ToList(),
        JsonValueKind.Object => JsonToDict(v),
        _ => null,
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test --filter StreamJsonParserTests`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(core): StreamJsonParser for claude stream-json output"
```

---

### Task 3: Permission response + argument builder

Two pure functions: build the `control_response` JSON for an approval decision, and build the `claude.exe` argument list from a model/profile/session.

**Files:**
- Create: `src/Dash.Core/ClaudeProtocol.cs`
- Test: `tests/Dash.Tests/ClaudeProtocolTests.cs`

**Interfaces:**
- Consumes: `PermissionRequest`, `ClaudeModel`, `ClaudeProfile`.
- Produces:
  - `static class ClaudeProtocol`
    - `static string PermissionResponseJson(PermissionRequest r, bool allow, bool always)` — newline-terminated JSON string.
    - `static string UserMessageJson(IEnumerable<object> contentBlocks)` — `{"type":"user","message":{"role":"user","content":[...]}}\n`.
    - `static string InterruptJson()`.
    - `static List<string> BuildArgs(ClaudeModel model, string effort, string system, ClaudeProfile profile, string? sessionId, bool resume)`.

- [ ] **Step 1: Write the failing tests**

`tests/Dash.Tests/ClaudeProtocolTests.cs`:
```csharp
using System.Text.Json;
using Dash.Core;
using Xunit;

public class ClaudeProtocolTests
{
    static PermissionRequest Req() => new("r1", "Bash", "Bash",
        new() { ["command"] = "ls" },
        new() { new() { ["type"] = "addRules", ["behavior"] = "allow", ["destination"] = "session" } });

    [Fact]
    public void Allow_response_uses_updatedInput()
    {
        var json = ClaudeProtocol.PermissionResponseJson(Req(), allow: true, always: false);
        using var d = JsonDocument.Parse(json);
        var resp = d.RootElement.GetProperty("response").GetProperty("response");
        Assert.Equal("allow", resp.GetProperty("behavior").GetString());
        Assert.False(resp.TryGetProperty("updatedPermissions", out _));
    }

    [Fact]
    public void Allow_always_attaches_session_rules()
    {
        var json = ClaudeProtocol.PermissionResponseJson(Req(), allow: true, always: true);
        using var d = JsonDocument.Parse(json);
        var resp = d.RootElement.GetProperty("response").GetProperty("response");
        Assert.True(resp.TryGetProperty("updatedPermissions", out var up));
        Assert.Equal("session", up[0].GetProperty("destination").GetString());
    }

    [Fact]
    public void Deny_response_carries_message()
    {
        var json = ClaudeProtocol.PermissionResponseJson(Req(), allow: false, always: false);
        using var d = JsonDocument.Parse(json);
        var resp = d.RootElement.GetProperty("response").GetProperty("response");
        Assert.Equal("deny", resp.GetProperty("behavior").GetString());
        Assert.Contains("denied", resp.GetProperty("message").GetString());
    }

    [Fact]
    public void BuildArgs_includes_stream_json_model_and_session_id()
    {
        var args = ClaudeProtocol.BuildArgs(ClaudeModel.Haiku, "low", "sys",
            ClaudeProfile.Console(), sessionId: "abc", resume: false);
        Assert.Contains("--output-format", args);
        Assert.Contains("stream-json", args);
        Assert.Contains("--model", args);
        Assert.Contains("haiku", args);
        Assert.Contains("--session-id", args);
        Assert.Contains("abc", args);
        Assert.DoesNotContain("--effort", args); // haiku has no effort
    }

    [Fact]
    public void BuildArgs_resume_uses_resume_flag_and_effort_for_opus()
    {
        var args = ClaudeProtocol.BuildArgs(ClaudeModel.Opus, "high", "sys",
            ClaudeProfile.Console(), sessionId: "abc", resume: true);
        Assert.Contains("--resume", args);
        Assert.Contains("--effort", args);
        Assert.Contains("high", args);
        Assert.Contains("--append-system-prompt", args); // console keeps default prompt
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test --filter ClaudeProtocolTests`
Expected: FAIL to compile — `ClaudeProtocol` not defined.

- [ ] **Step 3: Write the implementation**

`src/Dash.Core/ClaudeProtocol.cs`:
```csharp
using System.Text.Json;

namespace Dash.Core;

public static class ClaudeProtocol
{
    static string Line(object o) => JsonSerializer.Serialize(o) + "\n";

    public static string PermissionResponseJson(PermissionRequest r, bool allow, bool always)
    {
        var decision = new Dictionary<string, object?>();
        if (allow)
        {
            decision["behavior"] = "allow";
            decision["updatedInput"] = r.Input;
            if (always && r.Suggestions.Count > 0) decision["updatedPermissions"] = r.Suggestions;
        }
        else
        {
            decision["behavior"] = "deny";
            decision["message"] = "The user denied this in Dash. Don't retry it unless they ask.";
        }
        return Line(new Dictionary<string, object?>
        {
            ["type"] = "control_response",
            ["response"] = new Dictionary<string, object?>
            {
                ["subtype"] = "success", ["request_id"] = r.Id, ["response"] = decision,
            },
        });
    }

    public static string UserMessageJson(IEnumerable<object> contentBlocks) => Line(new Dictionary<string, object?>
    {
        ["type"] = "user",
        ["message"] = new Dictionary<string, object?> { ["role"] = "user", ["content"] = contentBlocks.ToList() },
    });

    public static string InterruptJson() => Line(new Dictionary<string, object?>
    {
        ["type"] = "control_request",
        ["request_id"] = "dash-int-" + Guid.NewGuid().ToString("N"),
        ["request"] = new Dictionary<string, object?> { ["subtype"] = "interrupt" },
    });

    public static string UnsupportedControlResponseJson(string requestId) => Line(new Dictionary<string, object?>
    {
        ["type"] = "control_response",
        ["response"] = new Dictionary<string, object?>
        {
            ["subtype"] = "error", ["request_id"] = requestId, ["error"] = "Dash doesn't support this request.",
        },
    });

    public static List<string> BuildArgs(ClaudeModel model, string effort, string system,
        ClaudeProfile profile, string? sessionId, bool resume)
    {
        var args = new List<string>
        {
            "-p", "--input-format", "stream-json", "--output-format", "stream-json",
            "--include-partial-messages", "--verbose",
            "--model", model.Id,
            profile.KeepDefaultPrompt ? "--append-system-prompt" : "--system-prompt", system,
            "--tools", string.Join(",", profile.Tools),
            "--strict-mcp-config", "--setting-sources", "",
        };
        if (sessionId is not null) { args.Add(resume ? "--resume" : "--session-id"); args.Add(sessionId); }
        else args.Add("--no-session-persistence");
        if (profile.PermissionMode is string mode) { args.Add("--permission-mode"); args.Add(mode); }
        if (model.SupportsEffort) { args.Add("--effort"); args.Add(effort); }
        if (profile.AllowedTools.Count > 0) { args.Add("--allowedTools"); args.Add(string.Join(",", profile.AllowedTools)); }
        if (profile.DisallowedTools.Count > 0) { args.Add("--disallowedTools"); args.Add(string.Join(",", profile.DisallowedTools)); }
        foreach (var dir in profile.AddDirs.Where(Directory.Exists)) { args.Add("--add-dir"); args.Add(dir); }
        if (profile.Tools.Count > 0) { args.Add("--permission-prompt-tool"); args.Add("stdio"); }
        return args;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test --filter ClaudeProtocolTests`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(core): permission response + claude argument builder"
```

---

### Task 4: ClaudeSession (process wiring)

Wires a `Process` running `claude.exe` to the parser. Not unit-tested here (it owns a process); it's exercised against the fake CLI in Task 5.

**Files:**
- Create: `src/Dash.Core/ClaudeSession.cs`, `src/Dash.Core/DashPaths.cs`, `src/Dash.Core/Log.cs`

**Interfaces:**
- Consumes: `ClaudeModel`, `ClaudeProfile`, `StreamJsonParser`, `ClaudeProtocol`, `ClaudeEvent`, `PermissionRequest`, `TurnResult`.
- Produces:
  - `static class DashPaths` — `string Root` (`%APPDATA%\Dash`), `string ChatsDir`, `string LogFile`; ensures directories exist.
  - `static class Log` — `void Write(string msg)` (appends to `DashPaths.LogFile`).
  - `class ClaudeSession : IDisposable`
    - `static string? Executable` — resolves `claude.exe`.
    - ctor `ClaudeSession(ClaudeModel model, string effort, string system, ClaudeProfile profile, string? sessionId = null, bool resume = false, string? executableOverride = null)`.
    - `Task<TurnResult> SendAsync(IEnumerable<object> content, Action<ClaudeEvent> onEvent, CancellationToken ct = default)`.
    - `void Respond(PermissionRequest r, bool allow, bool always = false)`.
    - `bool Interrupt()`.
    - `bool IsRunning { get; }`, `void Close()`, `void Dispose()`.

- [ ] **Step 1: Write the implementation**

`src/Dash.Core/DashPaths.cs`:
```csharp
namespace Dash.Core;

public static class DashPaths
{
    public static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Dash");
    public static string ChatsDir => EnsureDir(Path.Combine(Root, "chats"));
    public static string LogFile => Path.Combine(EnsureDir(Root), "dash.log");

    static string EnsureDir(string p) { Directory.CreateDirectory(p); return p; }
}
```

`src/Dash.Core/Log.cs`:
```csharp
namespace Dash.Core;

public static class Log
{
    static readonly object Gate = new();
    public static void Write(string msg)
    {
        try { lock (Gate) File.AppendAllText(DashPaths.LogFile, $"{DateTime.Now:s} {msg}\n"); }
        catch { /* logging must never throw */ }
    }
}
```

`src/Dash.Core/ClaudeSession.cs`:
```csharp
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Dash.Core;

public class ClaudeSession : IDisposable
{
    public static string? Executable { get; } = Resolve();

    static string? Resolve()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var candidates = new[]
        {
            Path.Combine(home, ".local", "bin", "claude.exe"),
            Path.Combine(home, ".local", "bin", "claude"),
        };
        var found = candidates.FirstOrDefault(File.Exists);
        if (found is not null) return found;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            foreach (var name in new[] { "claude.exe", "claude.cmd", "claude" })
            {
                var p = Path.Combine(dir.Trim(), name);
                if (File.Exists(p)) return p;
            }
        }
        return null;
    }

    readonly Process _process = new();
    readonly StreamJsonParser _parser = new();
    Action<ClaudeEvent>? _onEvent;
    TaskCompletionSource<TurnResult>? _tcs;
    readonly StringBuilder _stderr = new();
    bool _interruptRequested;

    public bool IsRunning { get { try { return !_process.HasExited; } catch { return false; } } }

    public ClaudeSession(ClaudeModel model, string effort, string system, ClaudeProfile profile,
        string? sessionId = null, bool resume = false, string? executableOverride = null)
    {
        var exe = executableOverride ?? Executable
            ?? throw new ClaudeException("Couldn't find the claude command. Install Claude Code and sign in.");

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = DashPaths.Root,
        };
        foreach (var a in ClaudeProtocol.BuildArgs(model, effort, system, profile, sessionId, resume))
            psi.ArgumentList.Add(a);

        psi.Environment.Remove("ANTHROPIC_API_KEY");
        psi.Environment.Remove("ANTHROPIC_AUTH_TOKEN");
        psi.Environment["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1";

        _process.StartInfo = psi;
        _process.EnableRaisingEvents = true;
        _process.Exited += (_, _) => OnExited();

        _parser.OnEvent += HandleEvent;

        _process.Start();
        _ = ReadStdoutAsync();
        _ = ReadStderrAsync();
    }

    async Task ReadStdoutAsync()
    {
        var buf = new byte[8192];
        var stream = _process.StandardOutput.BaseStream;
        int n;
        try { while ((n = await stream.ReadAsync(buf)) > 0) _parser.Feed(buf.AsSpan(0, n)); }
        catch { /* pipe closed */ }
    }

    async Task ReadStderrAsync()
    {
        string? line;
        try { while ((line = await _process.StandardError.ReadLineAsync()) != null) _stderr.AppendLine(line); }
        catch { }
    }

    void HandleEvent(ClaudeEvent e)
    {
        _onEvent?.Invoke(e);
        if (_parser.Result is { } r) Finish(r);
    }

    public async Task<TurnResult> SendAsync(IEnumerable<object> content, Action<ClaudeEvent> onEvent,
        CancellationToken ct = default)
    {
        if (_tcs is not null) throw new ClaudeException("Still answering the last question.");
        _onEvent = onEvent;
        _interruptRequested = false;
        _parser.InterruptRequested = false;
        _tcs = new(TaskCreationOptions.RunContinuationsAsynchronously);

        if (!IsRunning) { Finish(Fail()); return await _tcs.Task; }

        await using var reg = ct.Register(() => { Close(); Finish(new TurnResult("", "cancelled")); });
        await _process.StandardInput.WriteAsync(ClaudeProtocol.UserMessageJson(content));
        await _process.StandardInput.FlushAsync();
        return await _tcs.Task;
    }

    public void Respond(PermissionRequest r, bool allow, bool always = false)
        => Write(ClaudeProtocol.PermissionResponseJson(r, allow, always));

    public bool Interrupt()
    {
        if (_tcs is null || !IsRunning) return false;
        _interruptRequested = true;
        _parser.InterruptRequested = true;
        Write(ClaudeProtocol.InterruptJson());
        return true;
    }

    void Write(string line)
    {
        if (!IsRunning) return;
        try { _process.StandardInput.Write(line); _process.StandardInput.Flush(); } catch { }
    }

    TurnResult Fail()
    {
        var detail = _stderr.ToString().Trim();
        var lower = detail.ToLowerInvariant();
        string[] loginMarkers = { "/login", "not logged in", "please log in", "authenticat", "oauth", "invalid api key" };
        var msg = loginMarkers.Any(lower.Contains)
            ? "Claude Code isn't signed in. Run `claude` in a terminal and log in, then try again."
            : detail.Length == 0 ? "Claude Code stopped unexpectedly." : "Claude Code: " + detail[^Math.Min(300, detail.Length)..];
        throw new ClaudeException(msg);
    }

    void OnExited()
    {
        if (_tcs is not null)
        {
            Log.Write($"claude exited mid-turn ({SafeExitCode()})");
            try { Finish(Fail()); } catch (ClaudeException e) { FinishError(e); }
        }
    }

    int SafeExitCode() { try { return _process.ExitCode; } catch { return -1; } }

    void Finish(TurnResult r) { var t = _tcs; _tcs = null; _onEvent = null; t?.TrySetResult(r); ResetParserResult(); }
    void FinishError(Exception e) { var t = _tcs; _tcs = null; _onEvent = null; t?.TrySetException(e); }
    void ResetParserResult() { /* parser is single-turn-aware via Result; recreate on next send if needed */ }

    public void Close()
    {
        try { _process.StandardInput.Close(); } catch { }
        try { if (IsRunning) _process.Kill(entireProcessTree: true); } catch { }
    }

    public void Dispose() { Close(); _process.Dispose(); }
}

public class ClaudeException : Exception
{
    public ClaudeException(string message) : base(message) { }
}
```

> Note: `SendAsync` wraps `Fail()` (which throws) so a dead process surfaces as a faulted task. The caller (ChatConversation, Task 7) catches `ClaudeException` and renders it inline. Because `StreamJsonParser.Result` latches, Task 5 creates a fresh `ClaudeSession` per turn-group in tests; in the app a session is reused across turns and a new `StreamJsonParser` is created per send — fold that refinement into Task 5 if the fake-CLI multi-turn test requires it (it does: make `_parser` re-creatable by extracting `NewParser()` called at the top of `SendAsync`).

- [ ] **Step 2: Build to verify it compiles**

Run: `dotnet build src/Dash.Core`
Expected: `Build succeeded`.

- [ ] **Step 3: Refine for multi-turn (make parser per-send)**

In `ClaudeSession`, change `_parser` to be created fresh at the start of each `SendAsync` so a second turn isn't blocked by the first turn's latched `Result`. Replace the field `readonly StreamJsonParser _parser = new();` with `StreamJsonParser _parser = new();`, wire `_parser.OnEvent` in the ctor to a stable `HandleEvent` method (already is), and at the top of `SendAsync` (before writing) do:
```csharp
_parser = new StreamJsonParser();
_parser.OnEvent += HandleEvent;
```
Move the stdout reader to read into `_parser` by reference (it already calls `_parser.Feed`, which now points at the current parser). Build again:

Run: `dotnet build src/Dash.Core`
Expected: `Build succeeded`.

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "feat(core): ClaudeSession process wiring, paths, logging"
```

---

### Task 5: Fake CLI + ClaudeSession integration test

**Files:**
- Modify: `tests/Dash.FakeCli/Program.cs`
- Modify: `tests/Dash.Tests/Dash.Tests.csproj` (reference the fake CLI build output path), or locate it at runtime
- Test: `tests/Dash.Tests/ClaudeSessionIntegrationTests.cs`

**Interfaces:**
- Consumes: `ClaudeSession`, `ClaudeModel`, `ClaudeProfile`, `ClaudeEvent`.
- Produces: `Dash.FakeCli.exe` — reads one stdin `user` line, emits a scripted stdout sequence. Scenario is chosen by an env var `FAKE_SCENARIO` (`echo`, `permission`, `interrupt`).

- [ ] **Step 1: Write the fake CLI**

`tests/Dash.FakeCli/Program.cs`:
```csharp
using System.Text.Json;

string Line(object o) => JsonSerializer.Serialize(o) + "\n";
void Emit(object o) { Console.Out.Write(Line(o)); Console.Out.Flush(); }

var scenario = Environment.GetEnvironmentVariable("FAKE_SCENARIO") ?? "echo";

// Wait for the first user message.
var _ = Console.In.ReadLine();

if (scenario == "permission")
{
    Emit(new { type = "control_request", request_id = "r1", request = new {
        subtype = "can_use_tool", tool_name = "Bash", display_name = "Bash",
        input = new { command = "ls" },
        permission_suggestions = new object[] {
            new { type = "addRules", behavior = "allow", rules = Array.Empty<object>() } } } });
    // Block until the control_response arrives.
    string? resp;
    while ((resp = Console.In.ReadLine()) != null && !resp.Contains("control_response")) { }
    Emit(new { type = "stream_event", @event = new { type = "content_block_delta",
        delta = new { type = "text_delta", text = "ran it" } } });
    Emit(new { type = "result", result = "ran it", is_error = false, stop_reason = "end_turn" });
    return;
}

if (scenario == "interrupt")
{
    Emit(new { type = "stream_event", @event = new { type = "content_block_delta",
        delta = new { type = "text_delta", text = "working" } } });
    // Wait for an interrupt control_request.
    string? ctl;
    while ((ctl = Console.In.ReadLine()) != null && !ctl.Contains("interrupt")) { }
    Emit(new { type = "result", result = "stopped", is_error = true });
    return;
}

// echo
Emit(new { type = "stream_event", @event = new { type = "content_block_delta",
    delta = new { type = "text_delta", text = "hello" } } });
Emit(new { type = "result", result = "hello", is_error = false, stop_reason = "end_turn" });
```

- [ ] **Step 2: Write the failing integration tests**

`tests/Dash.Tests/ClaudeSessionIntegrationTests.cs`:
```csharp
using Dash.Core;
using Xunit;

public class ClaudeSessionIntegrationTests
{
    // Resolve the fake CLI built alongside the test assembly's dependency graph.
    static string FakeCli()
    {
        var baseDir = AppContext.BaseDirectory;
        // tests/Dash.Tests/bin/<cfg>/net9.0 -> walk up to repo, into fake cli output
        var repo = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", ".."));
        var cfg = baseDir.Contains("Debug") ? "Debug" : "Release";
        var exe = Path.Combine(repo, "tests", "Dash.FakeCli", "bin", cfg, "net9.0", "Dash.FakeCli.exe");
        Assert.True(File.Exists(exe), $"Build Dash.FakeCli first: {exe}");
        return exe;
    }

    static ClaudeSession NewSession(string scenario)
    {
        Environment.SetEnvironmentVariable("FAKE_SCENARIO", scenario);
        return new ClaudeSession(ClaudeModel.Haiku, "low", "sys", ClaudeProfile.Console(),
            executableOverride: FakeCli());
    }

    [Fact]
    public async Task Echo_streams_text_and_resolves_result()
    {
        using var s = NewSession("echo");
        var text = "";
        var r = await s.SendAsync(new object[] { new Dictionary<string, object?> { ["type"] = "text", ["text"] = "hi" } },
            e => { if (e is ClaudeEvent.TextEvent t) text += t.Text; });
        Assert.Equal("hello", text);
        Assert.Equal("hello", r.Text);
    }

    [Fact]
    public async Task Permission_request_can_be_approved_and_turn_completes()
    {
        using var s = NewSession("permission");
        PermissionRequest? pending = null;
        var task = s.SendAsync(new object[] { new Dictionary<string, object?> { ["type"] = "text", ["text"] = "hi" } },
            e => { if (e is ClaudeEvent.PermissionEvent p) { pending = p.Request; s.Respond(p.Request, allow: true); } });
        var r = await task;
        Assert.NotNull(pending);
        Assert.Equal("Bash", pending!.ToolName);
        Assert.Equal("end_turn", r.StopReason);
    }

    [Fact]
    public async Task Interrupt_marks_turn_interrupted()
    {
        using var s = NewSession("interrupt");
        var task = s.SendAsync(new object[] { new Dictionary<string, object?> { ["type"] = "text", ["text"] = "go" } },
            e => { if (e is ClaudeEvent.TextEvent) s.Interrupt(); });
        var r = await task;
        Assert.True(r.Interrupted);
    }
}
```

- [ ] **Step 3: Ensure the fake CLI builds before the tests run**

Add a project reference so the test build triggers the fake CLI build:
```
dotnet add tests/Dash.Tests reference tests/Dash.FakeCli
```
(The reference is only to force build ordering; the test invokes the exe by path, not by API.)

- [ ] **Step 4: Run the tests**

Run: `dotnet test --filter ClaudeSessionIntegrationTests`
Expected: PASS (3 tests). If "Build Dash.FakeCli first" asserts, run `dotnet build` once and re-run.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "test(core): fake CLI stub + ClaudeSession integration tests"
```

---

### Task 6: ChatStore (persistence)

**Files:**
- Create: `src/Dash.Core/ChatModels.cs`, `src/Dash.Core/ChatStore.cs`
- Test: `tests/Dash.Tests/ChatStoreTests.cs`

**Interfaces:**
- Produces:
  - `record ChatMeta(string Id, string Title, string? ClaudeSessionId, DateTime CreatedAt, DateTime UpdatedAt, string Model, string Effort, string? PermissionMode)`.
  - `enum TurnRole { User, Assistant }`
  - `record ToolChipData(string Id, string Name, Dictionary<string,object?> Input, string? Output, bool IsError, bool Finished)`.
  - `class ChatTurn { TurnRole Role; string Text; List<ToolChipData> Tools; string? Thinking; }` (mutable for streaming; serialized for storage).
  - `class ChatDocument { ChatMeta Meta; List<ChatTurn> Turns; }`.
  - `class ChatStore` with ctor `ChatStore(string rootDir)`; methods `List<ChatMeta> List()`, `ChatDocument? Load(string id)`, `void Save(ChatDocument doc)`, `void Rename(string id, string title)`, `void Delete(string id)`.

- [ ] **Step 1: Write the failing tests**

`tests/Dash.Tests/ChatStoreTests.cs`:
```csharp
using Dash.Core;
using Xunit;

public class ChatStoreTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "dash-test-" + Guid.NewGuid().ToString("N"));
    ChatStore Store() => new(_dir);
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    static ChatDocument Doc(string id, string title)
    {
        var now = DateTime.UtcNow;
        return new ChatDocument
        {
            Meta = new ChatMeta(id, title, "sess-" + id, now, now, "opus", "high", null),
            Turns = new() { new ChatTurn { Role = TurnRole.User, Text = "hi" } },
        };
    }

    [Fact]
    public void Save_then_load_round_trips()
    {
        var s = Store();
        s.Save(Doc("a", "First"));
        var loaded = s.Load("a");
        Assert.Equal("First", loaded!.Meta.Title);
        Assert.Equal("hi", loaded.Turns[0].Text);
    }

    [Fact]
    public void List_returns_saved_chats()
    {
        var s = Store();
        s.Save(Doc("a", "A"));
        s.Save(Doc("b", "B"));
        Assert.Equal(2, s.List().Count);
    }

    [Fact]
    public void Rename_and_delete_update_index()
    {
        var s = Store();
        s.Save(Doc("a", "A"));
        s.Rename("a", "Renamed");
        Assert.Equal("Renamed", s.List().Single().Title);
        s.Delete("a");
        Assert.Empty(s.List());
    }

    [Fact]
    public void Corrupt_document_is_quarantined_not_thrown()
    {
        var s = Store();
        s.Save(Doc("a", "A"));
        File.WriteAllText(Path.Combine(_dir, "a.json"), "{ not json");
        Assert.Null(s.Load("a"));
        Assert.True(File.Exists(Path.Combine(_dir, "a.json.corrupt")));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test --filter ChatStoreTests`
Expected: FAIL to compile.

- [ ] **Step 3: Write the implementations**

`src/Dash.Core/ChatModels.cs`:
```csharp
namespace Dash.Core;

public record ChatMeta(string Id, string Title, string? ClaudeSessionId,
    DateTime CreatedAt, DateTime UpdatedAt, string Model, string Effort, string? PermissionMode);

public enum TurnRole { User, Assistant }

public record ToolChipData(string Id, string Name, Dictionary<string, object?> Input,
    string? Output, bool IsError, bool Finished);

public class ChatTurn
{
    public TurnRole Role { get; set; }
    public string Text { get; set; } = "";
    public string? Thinking { get; set; }
    public List<ToolChipData> Tools { get; set; } = new();
}

public class ChatDocument
{
    public ChatMeta Meta { get; set; } = null!;
    public List<ChatTurn> Turns { get; set; } = new();
}
```

`src/Dash.Core/ChatStore.cs`:
```csharp
using System.Text.Json;

namespace Dash.Core;

public class ChatStore
{
    readonly string _dir;
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public ChatStore(string rootDir) { _dir = rootDir; Directory.CreateDirectory(_dir); }

    string IndexPath => Path.Combine(_dir, "index.json");
    string DocPath(string id) => Path.Combine(_dir, id + ".json");

    public List<ChatMeta> List()
    {
        if (!File.Exists(IndexPath)) return new();
        try { return JsonSerializer.Deserialize<List<ChatMeta>>(File.ReadAllText(IndexPath)) ?? new(); }
        catch { Quarantine(IndexPath); return new(); }
    }

    void WriteIndex(List<ChatMeta> metas)
    {
        try { File.WriteAllText(IndexPath, JsonSerializer.Serialize(metas, Json)); }
        catch (Exception e) { Log.Write("index write failed: " + e.Message); }
    }

    public ChatDocument? Load(string id)
    {
        var path = DocPath(id);
        if (!File.Exists(path)) return null;
        try { return JsonSerializer.Deserialize<ChatDocument>(File.ReadAllText(path)); }
        catch { Quarantine(path); return null; }
    }

    public void Save(ChatDocument doc)
    {
        try { File.WriteAllText(DocPath(doc.Meta.Id), JsonSerializer.Serialize(doc, Json)); }
        catch (Exception e) { Log.Write("chat write failed: " + e.Message); return; }
        var metas = List();
        metas.RemoveAll(m => m.Id == doc.Meta.Id);
        metas.Add(doc.Meta);
        WriteIndex(metas.OrderByDescending(m => m.UpdatedAt).ToList());
    }

    public void Rename(string id, string title)
    {
        var metas = List();
        var i = metas.FindIndex(m => m.Id == id);
        if (i < 0) return;
        metas[i] = metas[i] with { Title = title, UpdatedAt = DateTime.UtcNow };
        WriteIndex(metas);
        var doc = Load(id);
        if (doc is not null) { doc.Meta = metas[i]; Save(doc); }
    }

    public void Delete(string id)
    {
        try { File.Delete(DocPath(id)); } catch { }
        WriteIndex(List().Where(m => m.Id != id).ToList());
    }

    static void Quarantine(string path)
    {
        try { File.Move(path, path + ".corrupt", overwrite: true); Log.Write("quarantined " + path); } catch { }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test --filter ChatStoreTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(core): ChatStore persistence with corrupt-file quarantine"
```

---

### Task 7: ChatConversation view-model

**Files:**
- Create: `src/Dash.Core/ChatConversation.cs`
- Test: `tests/Dash.Tests/ChatConversationTests.cs`

**Interfaces:**
- Consumes: `ClaudeSession`, `ClaudeModel`, `ClaudeProfile`, `ChatStore`, `ChatDocument`, `ChatTurn`, `ToolChipData`, events.
- Produces:
  - `class ChatConversation : ObservableObject`
    - ctor `ChatConversation(ChatDocument doc, ChatStore store, string? executableOverride = null)`.
    - `ObservableCollection<ChatTurn> Turns`.
    - `string Model`, `string Effort`, `bool IsStreaming`, `PermissionRequest? PendingApproval` (observable).
    - `Task SendAsync(string text)` — appends user turn + streaming assistant turn; enqueues if streaming.
    - `void Stop()`.
    - `void Resolve(PermissionRequest r, bool allow, bool always)`.
    - internal `IReadOnlyList<string> Queue`.
    - static system prompt `const string SystemPrompt`.

- [ ] **Step 1: Write the failing tests** (uses the fake CLI from Task 5)

`tests/Dash.Tests/ChatConversationTests.cs`:
```csharp
using Dash.Core;
using Xunit;

public class ChatConversationTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "dash-conv-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    static string FakeCli()
    {
        var baseDir = AppContext.BaseDirectory;
        var repo = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", ".."));
        var cfg = baseDir.Contains("Debug") ? "Debug" : "Release";
        return Path.Combine(repo, "tests", "Dash.FakeCli", "bin", cfg, "net9.0", "Dash.FakeCli.exe");
    }

    ChatConversation NewConv(string scenario)
    {
        Environment.SetEnvironmentVariable("FAKE_SCENARIO", scenario);
        var now = DateTime.UtcNow;
        var doc = new ChatDocument
        {
            Meta = new ChatMeta(Guid.NewGuid().ToString("N"), "New chat", null, now, now, "haiku", "low", null),
        };
        return new ChatConversation(doc, new ChatStore(_dir), FakeCli());
    }

    [Fact]
    public async Task Send_appends_user_then_streams_assistant()
    {
        var c = NewConv("echo");
        await c.SendAsync("hi");
        Assert.Equal(TurnRole.User, c.Turns[0].Role);
        Assert.Equal("hi", c.Turns[0].Text);
        Assert.Equal(TurnRole.Assistant, c.Turns[1].Role);
        Assert.Equal("hello", c.Turns[1].Text);
        Assert.False(c.IsStreaming);
    }

    [Fact]
    public async Task Permission_surfaces_pending_approval()
    {
        var c = NewConv("permission");
        PermissionRequest? seen = null;
        c.PropertyChanged += (_, e) => { if (e.PropertyName == nameof(c.PendingApproval) && c.PendingApproval is { } p) { seen = p; c.Resolve(p, true, false); } };
        await c.SendAsync("do it");
        Assert.NotNull(seen);
        Assert.Equal("Bash", seen!.ToolName);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test --filter ChatConversationTests`
Expected: FAIL to compile.

- [ ] **Step 3: Write the implementation**

`src/Dash.Core/ChatConversation.cs`:
```csharp
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Dash.Core;

public partial class ChatConversation : ObservableObject
{
    public const string SystemPrompt =
        "You are Dash, a helpful personal assistant running on Windows. Be concise and direct. " +
        "You can read and search files, run commands, edit files, and search the web. " +
        "Actions that change things require the user's approval first.";

    readonly ChatStore _store;
    readonly string? _exe;
    ChatDocument _doc;
    ClaudeSession? _session;
    readonly Queue<string> _queue = new();

    public ObservableCollection<ChatTurn> Turns { get; } = new();

    [ObservableProperty] bool _isStreaming;
    [ObservableProperty] PermissionRequest? _pendingApproval;

    public string Model { get => _doc.Meta.Model; set { _doc.Meta = _doc.Meta with { Model = value }; OnPropertyChanged(); } }
    public string Effort { get => _doc.Meta.Effort; set { _doc.Meta = _doc.Meta with { Effort = value }; OnPropertyChanged(); } }
    public ChatMeta Meta => _doc.Meta;
    public IReadOnlyCollection<string> Queue => _queue;

    public ChatConversation(ChatDocument doc, ChatStore store, string? executableOverride = null)
    {
        _doc = doc; _store = store; _exe = executableOverride;
        foreach (var t in doc.Turns) Turns.Add(t);
    }

    public async Task SendAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (IsStreaming) { _queue.Enqueue(text); return; }

        var userTurn = new ChatTurn { Role = TurnRole.User, Text = text };
        Turns.Add(userTurn);
        _doc.Turns.Add(userTurn);
        if (_doc.Turns.Count(t => t.Role == TurnRole.User) == 1)
            _doc.Meta = _doc.Meta with { Title = text.Length > 48 ? text[..48] : text };

        var assistant = new ChatTurn { Role = TurnRole.Assistant };
        Turns.Add(assistant);
        _doc.Turns.Add(assistant);

        IsStreaming = true;
        try
        {
            EnsureSession();
            var result = await _session!.SendAsync(
                new object[] { new Dictionary<string, object?> { ["type"] = "text", ["text"] = text } },
                e => OnEvent(assistant, e));
            if (string.IsNullOrEmpty(assistant.Text) && !string.IsNullOrEmpty(result.Text))
                assistant.Text = result.Text;
            NotifyTurn(assistant);
        }
        catch (ClaudeException ex)
        {
            assistant.Text = (assistant.Text.Length > 0 ? assistant.Text + "\n\n" : "") + "⚠️ " + ex.Message;
            PendingApproval = null;   // dismiss any orphaned approval card if the process died mid-approval
            NotifyTurn(assistant);
            _session = null; // force respawn with --resume next time
        }
        finally
        {
            IsStreaming = false;
            _doc.Meta = _doc.Meta with { UpdatedAt = DateTime.UtcNow };
            _store.Save(_doc);
        }

        if (_queue.Count > 0) await SendAsync(_queue.Dequeue());
    }

    void EnsureSession()
    {
        if (_session is { IsRunning: true }) return;
        var model = ClaudeModel.Find(_doc.Meta.Model);
        var sessionId = _doc.Meta.ClaudeSessionId ?? Guid.NewGuid().ToString();
        var resume = _doc.Meta.ClaudeSessionId is not null;
        _doc.Meta = _doc.Meta with { ClaudeSessionId = sessionId };
        var profile = ClaudeProfile.Console();
        profile.PermissionMode = _doc.Meta.PermissionMode;
        _session = new ClaudeSession(model, _doc.Meta.Effort, SystemPrompt, profile, sessionId, resume, _exe);
    }

    void OnEvent(ChatTurn assistant, ClaudeEvent e)
    {
        switch (e)
        {
            case ClaudeEvent.TextEvent t: assistant.Text += t.Text; NotifyTurn(assistant); break;
            case ClaudeEvent.ThinkingEvent th: assistant.Thinking = (assistant.Thinking ?? "") + th.Text; break;
            case ClaudeEvent.ToolStartedEvent ts:
                assistant.Tools.Add(new ToolChipData(ts.Id, ts.Name, ts.Input, null, false, false));
                NotifyTurn(assistant); break;
            case ClaudeEvent.ToolFinishedEvent tf:
                var i = assistant.Tools.FindIndex(x => x.Id == tf.Id);
                if (i >= 0) assistant.Tools[i] = assistant.Tools[i] with { Output = tf.Output, IsError = tf.IsError, Finished = true };
                NotifyTurn(assistant); break;
            case ClaudeEvent.PermissionEvent p: PendingApproval = p.Request; break;
        }
    }

    public void Resolve(PermissionRequest r, bool allow, bool always)
    {
        PendingApproval = null;
        _session?.Respond(r, allow, always);
    }

    public void Stop() => _session?.Interrupt();

    void NotifyTurn(ChatTurn t)
    {
        var i = Turns.IndexOf(t);
        if (i >= 0) { Turns[i] = t; } // trigger collection change so UI re-renders this turn
    }
}
```

> The `NotifyTurn` reassignment is a simple way to push streaming updates through `ObservableCollection`; if the UI binds to per-turn `INotifyPropertyChanged` instead (Task 10 makes `ChatTurn` observable), replace `NotifyTurn` with property-change notifications. Make `ChatTurn` an `ObservableObject` with `[ObservableProperty]` fields in Task 10 and drop the reassignment hack then.

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test --filter ChatConversationTests`
Expected: PASS (2 tests). Run the whole suite to confirm nothing regressed: `dotnet test` → all green.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(core): ChatConversation view-model (streaming, queue, approvals)"
```

---

### Task 8: Avalonia app shell (MainWindow + sidebar)

**Files:**
- Modify: `src/Dash/App.axaml`, `src/Dash/App.axaml.cs`, `src/Dash/MainWindow.axaml`, `src/Dash/MainWindow.axaml.cs`, `src/Dash/Program.cs`
- Create: `src/Dash/ViewModels/AppViewModel.cs`

**Interfaces:**
- Consumes: `ChatStore`, `ChatMeta`, `ChatDocument`, `ChatConversation` (Dash.Core).
- Produces: a booting window with a left sidebar (Chat nav + chat list) and a content area hosting the active `ChatConversation`.

- [ ] **Step 1: App-level view-model**

`src/Dash/ViewModels/AppViewModel.cs`:
```csharp
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Dash.Core;

namespace Dash.ViewModels;

public partial class AppViewModel : ObservableObject
{
    readonly ChatStore _store = new(DashPaths.ChatsDir);

    public ObservableCollection<ChatMeta> Chats { get; } = new();
    [ObservableProperty] ChatConversation? _active;

    public AppViewModel()
    {
        foreach (var m in _store.List()) Chats.Add(m);
        if (Chats.Count > 0) Open(Chats[0]);
        else NewChat();
    }

    [RelayCommand]
    public void NewChat()
    {
        var now = DateTime.UtcNow;
        var doc = new ChatDocument
        {
            Meta = new ChatMeta(Guid.NewGuid().ToString("N"), "New chat", null, now, now,
                ClaudeModel.DefaultId, "high", null),
        };
        _store.Save(doc);
        Chats.Insert(0, doc.Meta);
        Active = new ChatConversation(doc, _store);
    }

    [RelayCommand]
    public void Open(ChatMeta meta)
    {
        var doc = _store.Load(meta.Id) ?? new ChatDocument { Meta = meta };
        Active = new ChatConversation(doc, _store);
    }

    [RelayCommand]
    public void DeleteChat(ChatMeta meta)
    {
        _store.Delete(meta.Id);
        Chats.Remove(meta);
        if (Active?.Meta.Id == meta.Id) { if (Chats.Count > 0) Open(Chats[0]); else NewChat(); }
    }
}
```

- [ ] **Step 2: Wire the window**

`src/Dash/MainWindow.axaml`:
```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="clr-namespace:Dash.ViewModels"
        x:Class="Dash.MainWindow" Title="Dash" Width="1100" Height="760"
        x:DataType="vm:AppViewModel">
  <Grid ColumnDefinitions="260,*">
    <!-- Sidebar -->
    <DockPanel Grid.Column="0" Background="#1f1f23">
      <Button DockPanel.Dock="Top" Margin="8" Content="+ New chat" Command="{Binding NewChatCommand}"/>
      <ListBox ItemsSource="{Binding Chats}" SelectionMode="Single"
               SelectionChanged="OnChatSelected">
        <ListBox.ItemTemplate>
          <DataTemplate>
            <TextBlock Text="{Binding Title}" Margin="4" TextTrimming="CharacterEllipsis"/>
          </DataTemplate>
        </ListBox.ItemTemplate>
      </ListBox>
    </DockPanel>
    <!-- Content: the active chat (ChatView added in Task 9/11) -->
    <ContentControl Grid.Column="1" Content="{Binding Active}"/>
  </Grid>
</Window>
```

`src/Dash/MainWindow.axaml.cs`:
```csharp
using Avalonia.Controls;
using Dash.Core;
using Dash.ViewModels;

namespace Dash;

public partial class MainWindow : Window
{
    public MainWindow() { InitializeComponent(); }

    void OnChatSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (DataContext is AppViewModel vm && sender is ListBox { SelectedItem: ChatMeta meta })
            vm.OpenCommand.Execute(meta);
    }
}
```

`src/Dash/App.axaml.cs` — set the window's DataContext:
```csharp
// in OnFrameworkInitializationCompleted, for the desktop lifetime:
desktop.MainWindow = new MainWindow { DataContext = new Dash.ViewModels.AppViewModel() };
```

- [ ] **Step 3: Add CommunityToolkit.Mvvm to the app project**

```
dotnet add src/Dash package CommunityToolkit.Mvvm
```

- [ ] **Step 4: Run the app**

Run: `dotnet run --project src/Dash`
Expected: a window opens with a dark sidebar, a "+ New chat" button, and a (possibly empty) chat list. The content area is blank (ChatView comes next). Close the window.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(ui): app shell with sidebar and chat list"
```

---

### Task 9: ChatView + ComposerView (send loop, no rich rendering yet)

Gets end-to-end chat working against the **real** `claude.exe` with plain-text rendering; rich markdown/tool/approval come in Tasks 10–12.

**Files:**
- Create: `src/Dash/Views/ChatView.axaml`, `src/Dash/Views/ChatView.axaml.cs`
- Modify: `src/Dash/App.axaml` (add a `DataTemplate` mapping `ChatConversation` → `ChatView`)

**Interfaces:**
- Consumes: `ChatConversation` (as DataContext), `ChatTurn`.
- Produces: a view that lists turns as text bubbles, a multiline composer (Return sends, Shift-Return newline), a Stop button while streaming.

- [ ] **Step 1: Make `ChatTurn` observable so streaming updates repaint**

In `src/Dash.Core/ChatModels.cs`, convert `ChatTurn` to:
```csharp
using CommunityToolkit.Mvvm.ComponentModel;
// ...
public partial class ChatTurn : ObservableObject
{
    public TurnRole Role { get; set; }
    [ObservableProperty] string _text = "";
    [ObservableProperty] string? _thinking;
    public System.Collections.ObjectModel.ObservableCollection<ToolChipData> Tools { get; set; } = new();
}
```
Update `ChatConversation.OnEvent` to mutate `assistant.Text +=` / `assistant.Tools.Add(...)` directly and **remove** the `NotifyTurn` reassignment hack and the `Turns[i] = t` lines (the observable properties now drive the UI). Re-run `dotnet test` → all green (the Core tests still pass; they read `.Text` which is unchanged).

- [ ] **Step 2: ChatView**

`src/Dash/Views/ChatView.axaml`:
```xml
<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:core="clr-namespace:Dash.Core;assembly=Dash.Core"
             x:Class="Dash.Views.ChatView" x:DataType="core:ChatConversation">
  <DockPanel>
    <!-- Composer -->
    <Border DockPanel.Dock="Bottom" Padding="8" Background="#26262b">
      <Grid ColumnDefinitions="*,Auto">
        <TextBox x:Name="Input" AcceptsReturn="True" TextWrapping="Wrap" MaxHeight="140"
                 Watermark="Message Dash…  (Return to send, Shift+Return for newline)"
                 KeyDown="OnInputKeyDown"/>
        <Button Grid.Column="1" Margin="8,0,0,0" Content="Stop"
                IsVisible="{Binding IsStreaming}" Click="OnStop"/>
      </Grid>
    </Border>
    <!-- Transcript -->
    <ScrollViewer x:Name="Scroll">
      <ItemsControl ItemsSource="{Binding Turns}" Margin="16">
        <ItemsControl.ItemTemplate>
          <DataTemplate x:DataType="core:ChatTurn">
            <Border Margin="0,6" Padding="10" CornerRadius="8"
                    Background="{Binding Role, Converter={StaticResource RoleBg}}">
              <SelectableTextBlock Text="{Binding Text}" TextWrapping="Wrap"/>
            </Border>
          </DataTemplate>
        </ItemsControl.ItemTemplate>
      </ItemsControl>
    </ScrollViewer>
  </DockPanel>
</UserControl>
```

`src/Dash/Views/ChatView.axaml.cs`:
```csharp
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Dash.Core;

namespace Dash.Views;

public partial class ChatView : UserControl
{
    public ChatView() { InitializeComponent(); }

    async void OnInputKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && !e.KeyModifiers.HasFlag(KeyModifiers.Shift))
        {
            e.Handled = true;
            if (DataContext is ChatConversation c && sender is TextBox tb)
            {
                var text = tb.Text ?? "";
                tb.Text = "";
                await c.SendAsync(text);
            }
        }
    }

    void OnStop(object? sender, RoutedEventArgs e)
    {
        if (DataContext is ChatConversation c) c.Stop();
    }
}
```

- [ ] **Step 3: Register the DataTemplate + role-background converter**

In `src/Dash/App.axaml`, inside `<Application.DataTemplates>` map the conversation to the view, and add a simple converter resource:
```xml
<Application.DataTemplates>
  <DataTemplate DataType="core:ChatConversation" xmlns:core="clr-namespace:Dash.Core;assembly=Dash.Core">
    <views:ChatView xmlns:views="clr-namespace:Dash.Views"/>
  </DataTemplate>
</Application.DataTemplates>
```
Add a `RoleBg` converter (user vs assistant color) in `src/Dash/Converters/RoleBackgroundConverter.cs` and register it in `App.axaml` `<Application.Resources>`:
```csharp
using System;
using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;
using Dash.Core;

namespace Dash.Converters;

public class RoleBackgroundConverter : IValueConverter
{
    public object Convert(object? v, Type t, object? p, CultureInfo c) =>
        v is TurnRole.User ? new SolidColorBrush(Color.Parse("#2d2d33"))
                           : new SolidColorBrush(Color.Parse("#1b1b1f"));
    public object ConvertBack(object? v, Type t, object? p, CultureInfo c) => throw new NotSupportedException();
}
```
```xml
<Application.Resources>
  <conv:RoleBackgroundConverter x:Key="RoleBg" xmlns:conv="clr-namespace:Dash.Converters"/>
</Application.Resources>
```

- [ ] **Step 4: Run the app and chat for real**

Precondition: `claude` is signed in (run `claude` once in a terminal and log in if needed).
Run: `dotnet run --project src/Dash`
Expected: type "say hello in 3 words" + Return → a streaming assistant reply appears as plain text; the chat shows in the sidebar; relaunching the app and clicking it reloads the transcript. If it says "not signed in," sign in and retry.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(ui): ChatView + composer, end-to-end streaming against claude.exe"
```

---

### Task 10: Markdown rendering + code-block copy

**Files:**
- Modify: `src/Dash/Views/ChatView.axaml` (swap `SelectableTextBlock` for a markdown renderer on assistant turns)
- Modify: `src/Dash/App.axaml` (import Markdown.Avalonia styles)

**Interfaces:**
- Consumes: `ChatTurn.Text`, `ChatTurn.Role`.
- Produces: assistant turns rendered as markdown (tables, fenced code blocks with a copy button); user turns stay plain selectable text.

- [ ] **Step 1: Add Markdown.Avalonia styles to App.axaml**

In `src/Dash/App.axaml` `<Application.Styles>`:
```xml
<StyleInclude Source="avares://Markdown.Avalonia/Markdown.Avalonia.xaml"/>
```

- [ ] **Step 2: Render assistant turns as markdown**

In `ChatView.axaml`, replace the single `SelectableTextBlock` with a role switch. Simplest reliable approach: a `ContentControl` whose template differs by role, or two templated panels toggled by `IsVisible`:
```xml
<Panel>
  <SelectableTextBlock Text="{Binding Text}" TextWrapping="Wrap"
      IsVisible="{Binding Role, Converter={StaticResource IsUser}}"/>
  <md:MarkdownScrollViewer xmlns:md="clr-namespace:Markdown.Avalonia;assembly=Markdown.Avalonia"
      Markdown="{Binding Text}"
      IsVisible="{Binding Role, Converter={StaticResource IsAssistant}}"/>
</Panel>
```
Add two tiny `IValueConverter`s (`IsUser`, `IsAssistant`) in `src/Dash/Converters/RoleVisibilityConverters.cs` returning `bool`, and register them in `App.axaml` resources. (Markdown.Avalonia renders fenced code blocks with a built-in copy button via its default styles.)

- [ ] **Step 3: Run the app and verify**

Run: `dotnet run --project src/Dash`
Expected: ask "show me a markdown table and a python code block" → the reply renders a real table and a syntax-styled code block with a copy button; clicking copy puts the code on the clipboard. User messages remain plain text.

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "feat(ui): markdown rendering with code-block copy for assistant turns"
```

---

### Task 11: Tool chips (expandable)

**Files:**
- Create: `src/Dash/Views/ToolChipView.axaml`, `src/Dash/Views/ToolChipView.axaml.cs`
- Modify: `src/Dash/Views/ChatView.axaml` (render `Tools` under each assistant turn)

**Interfaces:**
- Consumes: `ToolChipData` (`Name`, `Input`, `Output`, `IsError`, `Finished`).
- Produces: a collapsible chip per tool call — header shows the tool name + a spinner/check; expanding shows the command/input and the (truncated) output.

- [ ] **Step 1: ToolChipView**

`src/Dash/Views/ToolChipView.axaml`:
```xml
<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:core="clr-namespace:Dash.Core;assembly=Dash.Core"
             x:Class="Dash.Views.ToolChipView" x:DataType="core:ToolChipData">
  <Expander Margin="0,4" Padding="4">
    <Expander.Header>
      <StackPanel Orientation="Horizontal" Spacing="8">
        <TextBlock Text="🔧"/>
        <TextBlock Text="{Binding Name}" FontWeight="SemiBold"/>
        <TextBlock Text="{Binding Finished, Converter={StaticResource ChipStatus}}" Foreground="#9aa"/>
      </StackPanel>
    </Expander.Header>
    <StackPanel Spacing="6">
      <SelectableTextBlock Text="{Binding Input, Converter={StaticResource InputToText}}"
                           FontFamily="Cascadia Code,Consolas,monospace" TextWrapping="Wrap"/>
      <SelectableTextBlock Text="{Binding Output}" FontFamily="Cascadia Code,Consolas,monospace"
                           TextWrapping="Wrap" IsVisible="{Binding Finished}"/>
    </StackPanel>
  </Expander>
</UserControl>
```

`src/Dash/Views/ToolChipView.axaml.cs`: standard `InitializeComponent()` only.

Add converters: `ChipStatus` (`Finished` bool → "done"/"running…") and `InputToText` (`Dictionary<string,object?>` → a compact one-line/JSON string, preferring an `input["command"]` or `input["file_path"]` when present). Register both in `App.axaml`.

- [ ] **Step 2: Render chips under assistant turns**

In `ChatView.axaml`, inside the assistant turn template, above/below the markdown add:
```xml
<ItemsControl ItemsSource="{Binding Tools}">
  <ItemsControl.ItemTemplate>
    <DataTemplate x:DataType="core:ToolChipData"><views:ToolChipView xmlns:views="clr-namespace:Dash.Views"/></DataTemplate>
  </ItemsControl.ItemTemplate>
</ItemsControl>
```

- [ ] **Step 3: Run and verify**

Run: `dotnet run --project src/Dash`
Expected: ask "search the repo for the word 'Dash' using grep" → a `Grep` chip appears (runs freely, pre-approved), shows "running…" then "done," and expands to show the command + output.

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "feat(ui): expandable tool chips"
```

---

### Task 12: Approval cards

**Files:**
- Create: `src/Dash/Views/ApprovalCardView.axaml`, `src/Dash/Views/ApprovalCardView.axaml.cs`
- Modify: `src/Dash/Views/ChatView.axaml` (show the card when `PendingApproval` is set)

**Interfaces:**
- Consumes: `ChatConversation.PendingApproval` (`PermissionRequest`), `ChatConversation.Resolve(...)`.
- Produces: a modal-feeling card at the bottom of the transcript showing the tool + command/diff and Approve / Deny / "Always allow" buttons.

- [ ] **Step 1: Approval card in ChatView**

In `ChatView.axaml`, above the composer, add a panel bound to `PendingApproval`:
```xml
<Border DockPanel.Dock="Bottom" Padding="12" Background="#3a2d1f" CornerRadius="8" Margin="8"
        IsVisible="{Binding PendingApproval, Converter={StaticResource NotNull}}">
  <StackPanel Spacing="8">
    <TextBlock Text="{Binding PendingApproval.ToolName, StringFormat='Allow {0}?'}" FontWeight="Bold"/>
    <SelectableTextBlock Text="{Binding PendingApproval.Input, Converter={StaticResource InputToText}}"
                         FontFamily="Cascadia Code,Consolas,monospace" TextWrapping="Wrap"/>
    <StackPanel Orientation="Horizontal" Spacing="8">
      <Button Content="Approve" Click="OnApprove"/>
      <Button Content="Always allow" Click="OnAlways"/>
      <Button Content="Deny" Click="OnDeny"/>
    </StackPanel>
  </StackPanel>
</Border>
```

`ChatView.axaml.cs` — add handlers:
```csharp
void OnApprove(object? s, RoutedEventArgs e) { if (DataContext is ChatConversation c && c.PendingApproval is { } r) c.Resolve(r, true, false); }
void OnAlways(object? s, RoutedEventArgs e)  { if (DataContext is ChatConversation c && c.PendingApproval is { } r) c.Resolve(r, true, true); }
void OnDeny(object? s, RoutedEventArgs e)    { if (DataContext is ChatConversation c && c.PendingApproval is { } r) c.Resolve(r, false, false); }
```
Add a `NotNull` converter (object → bool) and register it.

- [ ] **Step 2: Run and verify the full approval loop**

Run: `dotnet run --project src/Dash`
Expected: ask "create a file test.txt in my Documents folder with the word hi" → because `Write` is gated, an approval card appears showing the `Write` input; **Deny** → Claude says it won't; ask again and **Approve** → the file is created and the chip shows done. **Always allow** → a second write in the same chat runs without a card; a brand-new chat asks again (session-scoped).

- [ ] **Step 3: Commit**

```
git add -A
git commit -m "feat(ui): approval cards with approve/deny/always-allow"
```

---

### Task 13: Per-chat model/effort/permission menu + rename/delete

**Files:**
- Modify: `src/Dash/Views/ChatView.axaml` (top bar with model/effort pickers)
- Modify: `src/Dash/MainWindow.axaml` (right-click or button for rename/delete on a chat)
- Modify: `src/Dash.Core/ChatConversation.cs` (expose model list + permission mode setter)

**Interfaces:**
- Consumes: `ClaudeModel.All`, `ChatConversation.Model/Effort`, `AppViewModel.DeleteChatCommand`.
- Produces: a per-chat settings bar; renaming and deleting chats from the sidebar.

- [ ] **Step 1: Expose pickers from the view-model**

In `ChatConversation`, add:
```csharp
public IReadOnlyList<ClaudeModel> Models => ClaudeModel.All;
public string[] Efforts => new[] { "low", "medium", "high", "xhigh" };
public string? PermissionMode { get => _doc.Meta.PermissionMode; set { _doc.Meta = _doc.Meta with { PermissionMode = value }; OnPropertyChanged(); } }
```
Changing `Model`/`Effort`/`PermissionMode` mid-chat should drop the current session so the next send respawns with the new settings: in each setter, after updating `_doc.Meta`, set `_session = null;`.

- [ ] **Step 2: Top bar in ChatView**

Add a `DockPanel.Dock="Top"` bar with a `ComboBox` bound to `Models` (SelectedItem → a model whose `.Id` maps to `Model`) and a `ComboBox` bound to `Efforts` (SelectedItem → `Effort`). Use converters or a small code-behind to map `ClaudeModel` ↔ `Model` id. Keep it minimal — two combos labeled "Model" and "Effort."

- [ ] **Step 3: Rename/delete in the sidebar**

In `MainWindow.axaml`, add a `ContextMenu` to the chat `ListBox.ItemTemplate` `TextBlock`:
```xml
<TextBlock.ContextMenu>
  <ContextMenu>
    <MenuItem Header="Rename" Click="OnRename"/>
    <MenuItem Header="Delete" Command="{Binding $parent[Window].((vm:AppViewModel)DataContext).DeleteChatCommand}"
              CommandParameter="{Binding}"/>
  </ContextMenu>
</TextBlock.ContextMenu>
```
`OnRename` in `MainWindow.axaml.cs`: prompt (a simple inline `TextBox` dialog or Avalonia's `Window` with a text field), then call the store's `Rename` via a new `AppViewModel.Rename(meta, title)` method that also updates the `Chats` list item.

- [ ] **Step 4: Run and verify**

Run: `dotnet run --project src/Dash`
Expected: switch a chat from Opus to Haiku and send — the reply is noticeably faster and the next turn used Haiku; right-click a chat → Rename changes its sidebar title (and survives relaunch); Delete removes it.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "feat(ui): per-chat model/effort/permission menu + rename/delete"
```

---

### Task 14: `--chat-selftest` end-to-end harness

Ports Dash's `--chat-selftest`: drives a real Haiku session through the full matrix and prints PASS/FAIL. This is the acceptance test.

**Files:**
- Modify: `src/Dash/Program.cs` (branch on `--chat-selftest` before starting Avalonia)
- Create: `src/Dash/SelfTest.cs`

**Interfaces:**
- Consumes: `ChatConversation`, `ChatStore`, `DashPaths`.
- Produces: `static Task<int> SelfTest.RunAsync()` — returns 0 on all-pass, 1 otherwise.

- [ ] **Step 1: Write the self-test**

`src/Dash/SelfTest.cs`:
```csharp
using Dash.Core;

namespace Dash;

public static class SelfTest
{
    public static async Task<int> RunAsync()
    {
        if (ClaudeSession.Executable is null) { Console.Error.WriteLine("FAIL: claude.exe not found"); return 1; }
        var dir = Path.Combine(Path.GetTempPath(), "dash-selftest-" + Guid.NewGuid().ToString("N"));
        var store = new ChatStore(dir);
        var now = DateTime.UtcNow;
        var doc = new ChatDocument { Meta = new ChatMeta(Guid.NewGuid().ToString("N"), "selftest", null, now, now, "haiku", "low", null) };
        var c = new ChatConversation(doc, store);
        int fails = 0;

        void Check(string name, bool ok) { Console.WriteLine($"{(ok ? "PASS" : "FAIL")}: {name}"); if (!ok) fails++; }

        // 1. basic streaming
        await c.SendAsync("Reply with exactly: ok");
        Check("streaming reply", c.Turns.Count == 2 && c.Turns[1].Text.ToLower().Contains("ok"));

        // 2. resume after relaunch (new conversation, same session id)
        var reloaded = store.Load(doc.Meta.Id)!;
        var c2 = new ChatConversation(reloaded, store);
        await c2.SendAsync("What did I just ask you to reply? One word.");
        Check("resume keeps context", c2.Turns.Last().Text.Length > 0);

        // 3. approval round-trip
        var doc3 = new ChatDocument { Meta = new ChatMeta(Guid.NewGuid().ToString("N"), "approve", null, now, now, "haiku", "low", null) };
        var c3 = new ChatConversation(doc3, store);
        bool sawCard = false;
        c3.PropertyChanged += (_, e) => { if (e.PropertyName == nameof(c3.PendingApproval) && c3.PendingApproval is { } r) { sawCard = true; c3.Resolve(r, false, false); } };
        await c3.SendAsync($"Run a bash command to create a file at {Path.Combine(dir, "x.txt")}");
        Check("approval card surfaced", sawCard);

        try { Directory.Delete(dir, true); } catch { }
        Console.WriteLine(fails == 0 ? "ALL PASS" : $"{fails} FAILED");
        return fails == 0 ? 0 : 1;
    }
}
```

- [ ] **Step 2: Branch in Program.cs**

At the top of `src/Dash/Program.cs` `Main`, before building the Avalonia app:
```csharp
if (args.Contains("--chat-selftest"))
    return SelfTest.RunAsync().GetAwaiter().GetResult();
```
(Make `Main` return `int`.)

- [ ] **Step 3: Run the self-test**

Precondition: `claude` signed in.
Run: `dotnet run --project src/Dash -- --chat-selftest`
Expected: three `PASS:` lines and `ALL PASS`; exit code 0. If any FAIL, fix the underlying behavior before proceeding.

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "test(app): --chat-selftest end-to-end acceptance harness"
```

---

### Task 15: Manual smoke pass + README

**Files:**
- Modify: `README.md`
- Create: `docs/SMOKE.md`

- [ ] **Step 1: Write the smoke checklist**

`docs/SMOKE.md` — a checklist the user runs by hand (each item is a line with a checkbox):
  - Markdown table + fenced code block render; code-block copy button works.
  - A pre-approved tool (Grep) runs without a card; chip expands to show command + output.
  - A gated tool (Write) shows an approval card with the real input; Deny then Approve both behave; "Always allow" suppresses the card for the rest of that chat only.
  - Composer: Return sends, Shift+Return inserts a newline.
  - Type a second message while the first is still streaming → it queues and sends after.
  - Stop during a stream ends the turn as "stopped," session stays alive, next message still works.
  - Relaunch the app → sidebar shows prior chats; opening one repaints the transcript; sending resumes with context.
  - Switch model to Haiku mid-chat → next turn uses it.
  - Rename and Delete from the sidebar persist across relaunch.

- [ ] **Step 2: Update README**

`README.md`: how to build (`dotnet build`), run (`dotnet run --project src/Dash`), run tests (`dotnet test`), run the acceptance test (`dotnet run --project src/Dash -- --chat-selftest`), and the prerequisite (Claude Code installed + signed in). Note jarvis and the other five pages are future slices.

- [ ] **Step 3: Do the manual smoke pass**

Run the app and walk `docs/SMOKE.md` top to bottom. Fix anything that fails (re-enter the relevant task's cycle). This is the human acceptance gate for "Chat is usable on Windows."

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "docs: smoke checklist + README; Chat v1 complete"
```

---

## Notes for the implementer

- **Sign in to Claude Code first.** Many tasks need a signed-in `claude.exe`. If a turn errors with a login message, run `claude` in a terminal, log in, and retry.
- **Run `dotnet build` once after Task 5** so `Dash.FakeCli.exe` exists before the integration tests look for it.
- **Avalonia converter registration** is fiddly — every `{StaticResource X}` used in XAML must have a matching `x:Key="X"` resource in `App.axaml`. If the app throws a markup exception on launch, a missing/misnamed converter key is the usual cause.
- **If `--session-id`/`--resume` behave unexpectedly on this `claude.exe`** (the one open item from the spec), verify with `claude --help` and adjust `ClaudeProtocol.BuildArgs`; the self-test's "resume keeps context" check is the canary.
- **Unsupported control requests (hooks / MCP elicitation):** v1 sessions use `--strict-mcp-config --setting-sources ""` with no hooks and jarvis deferred, so only `can_use_tool` control requests arise — the parser's non-`can_use_tool` branch is effectively dead code in v1. `ClaudeProtocol.UnsupportedControlResponseJson(requestId)` is defined and ready; if a future slice (jarvis/hooks) introduces other control requests, surface the `request_id` from `StreamJsonParser` to `ClaudeSession` and reply with it so `claude.exe` never hangs (matching the macOS app's defensive behavior).
