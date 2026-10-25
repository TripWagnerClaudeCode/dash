using CommunityToolkit.Mvvm.ComponentModel;
using System.Collections.ObjectModel;

namespace Dash.Core;

public record ChatMeta(string Id, string Title, string? ClaudeSessionId,
    DateTime CreatedAt, DateTime UpdatedAt, string Model, string Effort, string? PermissionMode);

public enum TurnRole { User, Assistant }

public record ToolChipData(string Id, string Name, Dictionary<string, object?> Input,
    string? Output, bool IsError, bool Finished);

public partial class ChatTurn : ObservableObject
{
    public TurnRole Role { get; set; }
    [ObservableProperty] string _text = "";
    [ObservableProperty] string? _thinking;
    public ObservableCollection<ToolChipData> Tools { get; set; } = new();
}

public class ChatDocument
{
    public ChatMeta Meta { get; set; } = null!;
    public List<ChatTurn> Turns { get; set; } = new();
}
