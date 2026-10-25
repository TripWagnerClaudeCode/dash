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
