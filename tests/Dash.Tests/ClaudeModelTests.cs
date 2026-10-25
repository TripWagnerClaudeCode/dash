using Dash.Core;
using Xunit;

public class ClaudeModelTests
{
    [Fact]
    public void Find_unknown_id_returns_opus_default()
    {
        Assert.Equal(ClaudeModel.Opus.Id, ClaudeModel.Find("nope").Id);
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
        Assert.True(p.KeepDefaultPrompt);
    }
}
