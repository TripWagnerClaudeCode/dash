namespace Dash.Core;

public record ClaudeModel(string Id, string Name, string Blurb, bool SupportsEffort)
{
    public static readonly ClaudeModel Opus   = new("opus",   "Opus",   "best quality", true);
    public static readonly ClaudeModel Sonnet = new("sonnet", "Sonnet", "faster",       true);
    public static readonly ClaudeModel Haiku  = new("haiku",  "Haiku",  "fastest, lightest on limits", false);

    public static readonly ClaudeModel[] All = { Opus, Sonnet, Haiku };
    public static string DefaultId => Sonnet.Id;
    public const string DefaultEffort = "medium";
    public static readonly string[] Efforts = { "low", "medium", "high", "xhigh", "max" };
    /// <summary>Effort comes from the chat file on disk; anything unexpected falls back to the default.</summary>
    public static string ValidEffort(string? effort) => Efforts.Contains(effort) ? effort! : DefaultEffort;
    public static ClaudeModel Find(string id) => All.FirstOrDefault(m => m.Id == id) ?? Sonnet;
}
