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
