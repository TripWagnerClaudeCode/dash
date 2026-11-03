using System.Text.Json;

string Line(object o) => JsonSerializer.Serialize(o) + "\n";
void Emit(object o) { Console.Out.Write(Line(o)); Console.Out.Flush(); }

var scenario = Environment.GetEnvironmentVariable("FAKE_SCENARIO") ?? "echo";

// Wait for the first user message.
var _ = Console.In.ReadLine();

if (scenario == "permission")
{
    Emit(new { type = "control_request", request_id = "r1", request = new {
        subtype = "can_use_tool", tool_name = "Bash", display_name = "Bash",
        input = new { command = "ls" },
        permission_suggestions = new object[] {
            new { type = "addRules", behavior = "allow", rules = Array.Empty<object>() } } } });
    // Block until the control_response arrives.
    string? resp;
    while ((resp = Console.In.ReadLine()) != null && !resp.Contains("control_response")) { }
    Emit(new { type = "stream_event", @event = new { type = "content_block_delta",
        delta = new { type = "text_delta", text = "ran it" } } });
    Emit(new { type = "result", result = "ran it", is_error = false, stop_reason = "end_turn" });
    return;
}

if (scenario == "unsupported")
{
    // A control request Dash doesn't handle; it must answer with an error or this blocks forever.
    Emit(new { type = "control_request", request_id = "h1", request = new { subtype = "hook_callback" } });
    string? r;
    while ((r = Console.In.ReadLine()) != null && !(r.Contains("control_response") && r.Contains("h1"))) { }
    Emit(new { type = "result", result = r != null && r.Contains("\"error\"") ? "answered" : "wrong", is_error = false, stop_reason = "end_turn" });
    return;
}

if (scenario == "two-permissions")
{
    // Parallel tool calls: two approvals outstanding at once; both must be answered.
    foreach (var id in new[] { "p1", "p2" })
        Emit(new { type = "control_request", request_id = id, request = new {
            subtype = "can_use_tool", tool_name = "Bash", display_name = "Bash",
            input = new { command = "echo " + id }, permission_suggestions = Array.Empty<object>() } });
    var answered = new HashSet<string>();
    string? r;
    while (answered.Count < 2 && (r = Console.In.ReadLine()) != null)
        foreach (var id in new[] { "p1", "p2" }) if (r.Contains("control_response") && r.Contains(id)) answered.Add(id);
    Emit(new { type = "result", result = string.Join(",", answered.Order()), is_error = false, stop_reason = "end_turn" });
    return;
}

if (scenario == "cancel-permission")
{
    Emit(new { type = "control_request", request_id = "c1", request = new {
        subtype = "can_use_tool", tool_name = "Write", display_name = "Write",
        input = new { file_path = "x" }, permission_suggestions = Array.Empty<object>() } });
    Emit(new { type = "control_cancel_request", request_id = "c1" });
    Emit(new { type = "result", result = "cancelled", is_error = false, stop_reason = "end_turn" });
    return;
}

if (scenario == "interrupt")
{
    Emit(new { type = "stream_event", @event = new { type = "content_block_delta",
        delta = new { type = "text_delta", text = "working" } } });
    // Wait for an interrupt control_request.
    string? ctl;
    while ((ctl = Console.In.ReadLine()) != null && !ctl.Contains("interrupt")) { }
    Emit(new { type = "result", result = "stopped", is_error = true });
    return;
}

// echo
Emit(new { type = "stream_event", @event = new { type = "content_block_delta",
    delta = new { type = "text_delta", text = "hello" } } });
Emit(new { type = "result", result = "hello", is_error = false, stop_reason = "end_turn" });
