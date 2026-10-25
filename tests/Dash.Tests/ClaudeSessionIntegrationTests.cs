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
