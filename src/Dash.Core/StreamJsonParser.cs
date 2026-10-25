using System.Text.Json;

namespace Dash.Core;

public class StreamJsonParser
{
    public Action<ClaudeEvent>? OnEvent;
    public TurnResult? Result { get; private set; }
    public bool InterruptRequested { get; set; }

    private readonly List<byte> _buffer = new();

    public void Feed(ReadOnlySpan<byte> data)
    {
        foreach (var b in data) _buffer.Add(b);
        int nl;
        while ((nl = _buffer.IndexOf((byte)0x0A)) >= 0)
        {
            var line = _buffer.GetRange(0, nl).ToArray();
            _buffer.RemoveRange(0, nl + 1);
            if (line.Length == 0) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                Handle(doc.RootElement);
            }
            catch (JsonException) { /* skip malformed line */ }
        }
    }

    private void Handle(JsonElement e)
    {
        switch (Str(e, "type"))
        {
            case "stream_event":
                if (e.TryGetProperty("event", out var inner) &&
                    Str(inner, "type") == "content_block_delta" &&
                    inner.TryGetProperty("delta", out var delta))
                {
                    switch (Str(delta, "type"))
                    {
                        case "text_delta" when delta.TryGetProperty("text", out var t):
                            OnEvent?.Invoke(new ClaudeEvent.TextEvent(t.GetString() ?? "")); break;
                        case "thinking_delta" when delta.TryGetProperty("thinking", out var th):
                            OnEvent?.Invoke(new ClaudeEvent.ThinkingEvent(th.GetString() ?? "")); break;
                    }
                }
                break;

            case "assistant":
                foreach (var b in Content(e))
                    if (Str(b, "type") == "tool_use" && b.TryGetProperty("id", out var id) && b.TryGetProperty("name", out var nm))
                        OnEvent?.Invoke(new ClaudeEvent.ToolStartedEvent(
                            id.GetString()!, nm.GetString()!, ToDict(b, "input")));
                break;

            case "user":
                foreach (var b in Content(e))
                    if (Str(b, "type") == "tool_result" && b.TryGetProperty("tool_use_id", out var tid))
                        OnEvent?.Invoke(new ClaudeEvent.ToolFinishedEvent(
                            tid.GetString()!,
                            b.TryGetProperty("is_error", out var ie) && ie.ValueKind == JsonValueKind.True,
                            ResultText(b.TryGetProperty("content", out var c) ? c : (JsonElement?)null)));
                break;

            case "control_request":
                var reqId = Str(e, "request_id");
                if (reqId is null || !e.TryGetProperty("request", out var req)) break;
                if (Str(req, "subtype") != "can_use_tool" || Str(req, "tool_name") is not string tool)
                    break; // unsupported control requests are answered by ClaudeSession, not here
                var suggestions = req.TryGetProperty("permission_suggestions", out var ps)
                    ? KeepNarrowSuggestions(ps) : new();
                OnEvent?.Invoke(new ClaudeEvent.PermissionEvent(new PermissionRequest(
                    reqId, tool, Str(req, "display_name") ?? tool, ToDict(req, "input"), suggestions)));
                break;

            case "result":
                var text = Str(e, "result") ?? "";
                bool isError = e.TryGetProperty("is_error", out var er) && er.ValueKind == JsonValueKind.True;
                if (InterruptRequested && isError)
                    Result = new TurnResult(text, "interrupted", true);
                else if (isError)
                    Result = new TurnResult(text.Length > 0 ? text : "Claude Code reported an error.", "error");
                else
                    Result = new TurnResult(text, Str(e, "stop_reason"));
                break;
        }
    }

    public static List<Dictionary<string, object?>> KeepNarrowSuggestions(JsonElement arr)
    {
        var kept = new List<Dictionary<string, object?>>();
        if (arr.ValueKind != JsonValueKind.Array) return kept;
        foreach (var s in arr.EnumerateArray())
        {
            if (Str(s, "type") == "addRules" && Str(s, "behavior") == "allow")
            {
                var d = JsonToDict(s);
                d["destination"] = "session";
                kept.Add(d);
            }
        }
        return kept;
    }

    public static string ResultText(JsonElement? content)
    {
        string text = "";
        if (content is { ValueKind: JsonValueKind.String } s) text = s.GetString() ?? "";
        else if (content is { ValueKind: JsonValueKind.Array } a)
            text = string.Join("\n", a.EnumerateArray()
                .Where(b => b.TryGetProperty("text", out _))
                .Select(b => b.GetProperty("text").GetString() ?? ""));
        return text.Length > 30_000 ? text[..30_000] + "\n… (output truncated)" : text;
    }

    private static IEnumerable<JsonElement> Content(JsonElement e) =>
        e.TryGetProperty("message", out var m) && m.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array
            ? c.EnumerateArray() : Enumerable.Empty<JsonElement>();

    private static string? Str(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static Dictionary<string, object?> ToDict(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Object ? JsonToDict(v) : new();

    private static Dictionary<string, object?> JsonToDict(JsonElement o)
    {
        var d = new Dictionary<string, object?>();
        foreach (var p in o.EnumerateObject()) d[p.Name] = JsonToValue(p.Value);
        return d;
    }

    private static object? JsonToValue(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString(),
        JsonValueKind.Number => v.TryGetInt64(out var l) ? l : v.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Array => v.EnumerateArray().Select(JsonToValue).ToList(),
        JsonValueKind.Object => JsonToDict(v),
        _ => null,
    };
}
