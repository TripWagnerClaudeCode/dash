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
        var now = DateTime.UtcNow;
        var doc = new ChatDocument
        {
            Meta = new ChatMeta(Guid.NewGuid().ToString("N"), "New chat", null, now, now, "haiku", "low", null),
        };
        return new ChatConversation(doc, new ChatStore(_dir), FakeCli(),
            new Dictionary<string, string> { ["FAKE_SCENARIO"] = scenario });
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
