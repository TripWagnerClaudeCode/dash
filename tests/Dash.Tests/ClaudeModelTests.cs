using Dash.Core;
using Xunit;

public class ClaudeModelTests
{
    [Fact]
    public void Find_unknown_id_returns_sonnet_default()
    {
        Assert.Equal(ClaudeModel.Sonnet.Id, ClaudeModel.Find("nope").Id);
        Assert.Equal(ClaudeModel.Sonnet.Id, ClaudeModel.DefaultId);
        Assert.Equal("medium", ClaudeModel.DefaultEffort);
    }

    [Fact]
    public void Haiku_does_not_support_effort()
    {
        Assert.False(ClaudeModel.Haiku.SupportsEffort);
    }

    [Fact]
    public void Console_profile_allows_reads_and_gates_writes()
    {
        var p = ClaudeProfile.Console();
        Assert.Contains("Read", p.AllowedTools);
        Assert.Contains("WebSearch", p.AllowedTools);
        Assert.DoesNotContain("Bash", p.AllowedTools);
        Assert.Contains("Bash", p.Tools);
        Assert.False(p.KeepDefaultPrompt);
        Assert.DoesNotContain("Task", p.Tools);
        Assert.DoesNotContain("Task", p.AllowedTools);
    }
}
