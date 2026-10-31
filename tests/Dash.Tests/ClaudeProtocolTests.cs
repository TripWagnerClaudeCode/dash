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
        Assert.Contains("--system-prompt", args); // console replaces the default prompt
        Assert.DoesNotContain("--append-system-prompt", args);
    }
}
