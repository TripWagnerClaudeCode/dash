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
