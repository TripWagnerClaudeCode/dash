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
