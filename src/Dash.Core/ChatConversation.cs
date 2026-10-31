using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Dash.Core;

public partial class ChatConversation : ObservableObject
{
    public const string SystemPrompt =
        "You are Dash, a helpful personal assistant running on Windows. Be concise and direct.\n" +
        "Tools: use Read/Glob/Grep to find and read files (prefer them over shell commands), " +
        "Edit for targeted changes to existing files (Read the file first), Write for new files, " +
        "Bash for running commands (it is Git Bash: use POSIX syntax and forward slashes), " +
        "WebSearch/WebFetch for anything current or online. Use absolute paths. " +
        "Run independent tool calls in parallel.\n" +
        "Actions that change things require the user's approval; if one is denied, don't retry it unless asked. " +
        "Before deleting or overwriting, look at the target. Report results honestly, including failures.";

    readonly ChatStore _store;
    readonly string? _exe;
    readonly IReadOnlyDictionary<string, string>? _extraEnv;
    ChatDocument _doc;
    ClaudeSession? _session;
    readonly Queue<string> _queue = new();

    public ObservableCollection<ChatTurn> Turns { get; } = new();

    [ObservableProperty] bool _isStreaming;
    [ObservableProperty] PermissionRequest? _pendingApproval;

    public string Model { get => _doc.Meta.Model; set { _doc.Meta = _doc.Meta with { Model = value }; OnPropertyChanged(); } }
    public string Effort { get => _doc.Meta.Effort; set { _doc.Meta = _doc.Meta with { Effort = value }; OnPropertyChanged(); } }
    public ChatMeta Meta => _doc.Meta;
    public IReadOnlyCollection<string> Queue => _queue;

    public ChatConversation(ChatDocument doc, ChatStore store, string? executableOverride = null,
        IReadOnlyDictionary<string, string>? extraEnv = null)
    {
        _doc = doc; _store = store; _exe = executableOverride; _extraEnv = extraEnv;
        foreach (var t in doc.Turns) Turns.Add(t);
    }

    public async Task SendAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (IsStreaming) { _queue.Enqueue(text); return; }

        var userTurn = new ChatTurn { Role = TurnRole.User, Text = text };
        Turns.Add(userTurn);
        _doc.Turns.Add(userTurn);
        if (_doc.Turns.Count(t => t.Role == TurnRole.User) == 1)
            _doc.Meta = _doc.Meta with { Title = text.Length > 48 ? text[..48] : text };

        var assistant = new ChatTurn { Role = TurnRole.Assistant };
        Turns.Add(assistant);
        _doc.Turns.Add(assistant);

        IsStreaming = true;
        try
        {
            EnsureSession();
            var result = await _session!.SendAsync(
                new object[] { new Dictionary<string, object?> { ["type"] = "text", ["text"] = text } },
                e => OnEvent(assistant, e));
            if (string.IsNullOrEmpty(assistant.Text) && !string.IsNullOrEmpty(result.Text))
                assistant.Text = result.Text;
        }
        catch (ClaudeException ex)
        {
            assistant.Text = (assistant.Text.Length > 0 ? assistant.Text + "\n\n" : "") + "⚠️ " + ex.Message;
            PendingApproval = null;   // dismiss any orphaned approval card if the process died mid-approval
            _session = null; // force respawn with --resume next time
        }
        finally
        {
            IsStreaming = false;
            _doc.Meta = _doc.Meta with { UpdatedAt = DateTime.UtcNow };
            _store.Save(_doc);
        }

        if (_queue.Count > 0) await SendAsync(_queue.Dequeue());
    }

    void EnsureSession()
    {
        if (_session is { IsRunning: true }) return;
        var model = ClaudeModel.Find(_doc.Meta.Model);
        var sessionId = _doc.Meta.ClaudeSessionId ?? Guid.NewGuid().ToString();
        var resume = _doc.Meta.ClaudeSessionId is not null;
        _doc.Meta = _doc.Meta with { ClaudeSessionId = sessionId };
        var profile = ClaudeProfile.Console();
        profile.PermissionMode = _doc.Meta.PermissionMode;
        _session = new ClaudeSession(model, _doc.Meta.Effort, SystemPrompt, profile, sessionId, resume, _exe, extraEnv: _extraEnv);
    }

    void OnEvent(ChatTurn assistant, ClaudeEvent e)
    {
        switch (e)
        {
            case ClaudeEvent.TextEvent t: assistant.Text += t.Text; break;
            case ClaudeEvent.ThinkingEvent th: assistant.Thinking = (assistant.Thinking ?? "") + th.Text; break;
            case ClaudeEvent.ToolStartedEvent ts:
                assistant.Tools.Add(new ToolChipData(ts.Id, ts.Name, ts.Input, null, false, false));
                break;
            case ClaudeEvent.ToolFinishedEvent tf:
                var i = assistant.Tools.ToList().FindIndex(x => x.Id == tf.Id);
                if (i >= 0) assistant.Tools[i] = assistant.Tools[i] with { Output = tf.Output, IsError = tf.IsError, Finished = true };
                break;
            case ClaudeEvent.PermissionEvent p: PendingApproval = p.Request; break;
        }
    }

    public void Resolve(PermissionRequest r, bool allow, bool always)
    {
        PendingApproval = null;
        _session?.Respond(r, allow, always);
    }

    public void Stop() => _session?.Interrupt();
}
