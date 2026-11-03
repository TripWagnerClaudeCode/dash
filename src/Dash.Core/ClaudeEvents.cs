namespace Dash.Core;

public record PermissionRequest(
    string Id, string ToolName, string DisplayName,
    Dictionary<string, object?> Input,
    List<Dictionary<string, object?>> Suggestions)
{
    static readonly System.Text.Json.JsonSerializerOptions Indented = new() { WriteIndented = true };

    /// <summary>The full tool input, shown verbatim on the approval card so nothing is hidden.</summary>
    public string InputJson => System.Text.Json.JsonSerializer.Serialize(Input, Indented);
    public bool CanAlwaysAllow => Suggestions.Count > 0;
}

public abstract record ClaudeEvent
{
    public record TextEvent(string Text) : ClaudeEvent;
    public record ThinkingEvent(string Text) : ClaudeEvent;
    public record ToolStartedEvent(string Id, string Name, Dictionary<string, object?> Input) : ClaudeEvent;
    public record ToolFinishedEvent(string Id, bool IsError, string Output) : ClaudeEvent;
    public record PermissionEvent(PermissionRequest Request) : ClaudeEvent;
    /// <summary>Claude Code withdrew a pending permission request (e.g. after an interrupt).</summary>
    public record PermissionCancelledEvent(string RequestId) : ClaudeEvent;
    /// <summary>A control request Dash doesn't handle; ClaudeSession answers it with an error.</summary>
    public record UnsupportedControlEvent(string RequestId) : ClaudeEvent;
}

public record TurnResult(string Text, string? StopReason = null, bool Interrupted = false);
