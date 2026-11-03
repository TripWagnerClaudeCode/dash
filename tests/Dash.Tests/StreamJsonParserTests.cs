using System.Text;
using Dash.Core;
using Xunit;

public class StreamJsonParserTests
{
    static List<ClaudeEvent> Run(string lines, bool interrupt = false)
    {
        var events = new List<ClaudeEvent>();
        var p = new StreamJsonParser { InterruptRequested = interrupt };
        p.OnEvent += events.Add;
        p.Feed(Encoding.UTF8.GetBytes(lines));
        return events;
    }

    const string TextDelta =
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}}\n" +
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}}\n";

    [Fact]
    public void Emits_text_deltas_in_order()
    {
        var e = Run(TextDelta).OfType<ClaudeEvent.TextEvent>().Select(x => x.Text).ToArray();
        Assert.Equal(new[] { "Hel", "lo" }, e);
    }

    [Fact]
    public void Tool_use_then_result_emits_started_and_finished()
    {
        var lines =
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}]}}\n" +
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":false,\"content\":\"out\"}]}}\n";
        var e = Run(lines);
        var started = Assert.IsType<ClaudeEvent.ToolStartedEvent>(e[0]);
        Assert.Equal("Bash", started.Name);
        var finished = Assert.IsType<ClaudeEvent.ToolFinishedEvent>(e[1]);
        Assert.Equal("t1", finished.Id);
        Assert.Equal("out", finished.Output);
    }

    [Fact]
    public void Permission_request_keeps_only_narrow_session_allow_rules()
    {
        var lines =
            "{\"type\":\"control_request\",\"request_id\":\"r1\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"Bash\",\"input\":{\"command\":\"rm x\"},\"permission_suggestions\":[" +
            "{\"type\":\"addRules\",\"behavior\":\"allow\",\"rules\":[]}," +
            "{\"type\":\"setMode\",\"mode\":\"acceptEdits\"}]}}\n";
        var perm = Assert.IsType<ClaudeEvent.PermissionEvent>(Run(lines)[0]).Request;
        Assert.Equal("Bash", perm.ToolName);
        Assert.Single(perm.Suggestions);
        Assert.Equal("session", perm.Suggestions[0]["destination"]);
    }

    [Fact]
    public void Result_success_sets_turn_result()
    {
        var p = new StreamJsonParser();
        p.Feed(Encoding.UTF8.GetBytes("{\"type\":\"result\",\"result\":\"done\",\"is_error\":false,\"stop_reason\":\"end_turn\"}\n"));
        Assert.Equal("done", p.Result!.Text);
        Assert.False(p.Result.Interrupted);
    }

    [Fact]
    public void Error_result_while_interrupting_is_marked_interrupted()
    {
        var p = new StreamJsonParser { InterruptRequested = true };
        p.Feed(Encoding.UTF8.GetBytes("{\"type\":\"result\",\"result\":\"stopped\",\"is_error\":true}\n"));
        Assert.True(p.Result!.Interrupted);
    }

    [Fact]
    public void Partial_line_buffers_until_newline()
    {
        var p = new StreamJsonParser();
        var seen = new List<ClaudeEvent>();
        p.OnEvent += seen.Add;
        p.Feed(Encoding.UTF8.GetBytes("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}"));
        Assert.Empty(seen);
        p.Feed(Encoding.UTF8.GetBytes("}}\n"));
        Assert.Single(seen);
    }

    [Fact]
    public void Unparseable_line_is_skipped()
    {
        var e = Run("not json\n" + TextDelta);
        Assert.Equal(2, e.OfType<ClaudeEvent.TextEvent>().Count());
    }

    [Fact]
    public void Tool_use_with_null_id_emits_no_ToolStartedEvent_and_does_not_throw()
    {
        // "id": null is valid JSON but must not flow into ToolStartedEvent.Id
        var line =
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":null,\"name\":\"Bash\",\"input\":{\"command\":\"ls\"}}]}}\n";
        var e = Run(line);
        Assert.Empty(e.OfType<ClaudeEvent.ToolStartedEvent>());
    }

    [Fact]
    public void Unsupported_control_request_emits_unsupported_event()
    {
        var e = Run("{\"type\":\"control_request\",\"request_id\":\"h1\",\"request\":{\"subtype\":\"hook_callback\"}}\n");
        Assert.Equal("h1", Assert.IsType<ClaudeEvent.UnsupportedControlEvent>(Assert.Single(e)).RequestId);
    }

    [Fact]
    public void Control_cancel_request_emits_cancel_event()
    {
        var e = Run("{\"type\":\"control_cancel_request\",\"request_id\":\"c1\"}\n");
        Assert.Equal("c1", Assert.IsType<ClaudeEvent.PermissionCancelledEvent>(Assert.Single(e)).RequestId);
    }
}
