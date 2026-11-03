using System.Diagnostics;
using System.Text;

namespace Dash.Core;

public class ClaudeSession : IDisposable
{
    public static string? Executable { get; } = Resolve();

    static string? Resolve()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var candidates = new[]
        {
            Path.Combine(home, ".local", "bin", "claude.exe"),
            Path.Combine(home, ".local", "bin", "claude"),
        };
        var found = candidates.FirstOrDefault(File.Exists);
        if (found is not null) return found;
        foreach (var raw in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            // Only absolute PATH entries: an empty or relative entry would resolve against the
            // current directory and let a planted claude.exe there be launched.
            var dir = raw.Trim().Trim('"');
            if (dir.Length == 0 || !Path.IsPathFullyQualified(dir)) continue;
            foreach (var name in new[] { "claude.exe", "claude.cmd", "claude" })
            {
                var p = Path.Combine(dir, name);
                if (File.Exists(p)) return p;
            }
        }
        return null;
    }

    readonly Process _process = new();
    StreamJsonParser _parser = new();
    Action<ClaudeEvent>? _onEvent;
    TaskCompletionSource<TurnResult>? _tcs;
    readonly StringBuilder _stderr = new();
    readonly object _stderrGate = new();

    public bool IsRunning { get { try { return !_process.HasExited; } catch { return false; } } }

    public ClaudeSession(ClaudeModel model, string effort, string system, ClaudeProfile profile,
        string? sessionId = null, bool resume = false, string? executableOverride = null,
        IReadOnlyDictionary<string, string>? extraEnv = null)
    {
        var exe = executableOverride ?? Executable
            ?? throw new ClaudeException("Couldn't find the claude command. Install Claude Code and sign in.");

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = DashPaths.Root,
        };
        foreach (var a in ClaudeProtocol.BuildArgs(model, effort, system, profile, sessionId, resume))
            psi.ArgumentList.Add(a);

        psi.Environment.Remove("ANTHROPIC_API_KEY");
        psi.Environment.Remove("ANTHROPIC_AUTH_TOKEN");
        psi.Environment["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1";

        if (extraEnv is not null)
            foreach (var kv in extraEnv) psi.Environment[kv.Key] = kv.Value;

        _process.StartInfo = psi;
        _process.EnableRaisingEvents = true;
        _process.Exited += (_, _) => OnExited();

        _parser.OnEvent += HandleEvent;

        _process.Start();
        _ = ReadStdoutAsync();
        _ = ReadStderrAsync();
    }

    async Task ReadStdoutAsync()
    {
        var buf = new byte[8192];
        var stream = _process.StandardOutput.BaseStream;
        int n;
        try { while ((n = await stream.ReadAsync(buf)) > 0) _parser.Feed(buf.AsSpan(0, n)); }
        catch { /* pipe closed */ }
        finally { OnStdoutClosed(); }
    }

    async Task ReadStderrAsync()
    {
        string? line;
        try { while ((line = await _process.StandardError.ReadLineAsync()) != null) lock (_stderrGate) _stderr.AppendLine(line); }
        catch { }
    }

    // stdout EOF is the authoritative "all output consumed" signal. If a turn is still
    // pending when the stream closes (process exited), finalize it here: success if a
    // result was parsed from the drained bytes, otherwise a failure. This runs only
    // after the reader has drained every byte, avoiding the race where Process.Exited
    // fires before the final `result` line is parsed.
    void OnStdoutClosed()
    {
        if (_tcs is null) return;
        if (_parser.Result is { } r) { Finish(r); return; }
        try { Finish(Fail()); } catch (ClaudeException e) { FinishError(e); }
    }

    void HandleEvent(ClaudeEvent e)
    {
        if (e is ClaudeEvent.UnsupportedControlEvent u)
        {
            Log.Write("declined unsupported control request " + u.RequestId);
            Write(ClaudeProtocol.UnsupportedControlResponseJson(u.RequestId));
            return;
        }
        _onEvent?.Invoke(e);
        if (_parser.Result is { } r) Finish(r);
    }

    public async Task<TurnResult> SendAsync(IEnumerable<object> content, Action<ClaudeEvent> onEvent,
        CancellationToken ct = default)
    {
        if (_tcs is not null) throw new ClaudeException("Still answering the last question.");
        _onEvent = onEvent;

        _parser = new StreamJsonParser();
        _parser.OnEvent += HandleEvent;

        _tcs = new(TaskCreationOptions.RunContinuationsAsynchronously);

        if (!IsRunning) { Finish(Fail()); return await _tcs.Task; }

        await using var reg = ct.Register(() => { Close(); Finish(new TurnResult("", "cancelled")); });
        await _process.StandardInput.WriteAsync(ClaudeProtocol.UserMessageJson(content));
        await _process.StandardInput.FlushAsync();
        return await _tcs.Task;
    }

    public void Respond(PermissionRequest r, bool allow, bool always = false)
        => Write(ClaudeProtocol.PermissionResponseJson(r, allow, always));

    public bool Interrupt()
    {
        if (_tcs is null || !IsRunning) return false;
        _parser.InterruptRequested = true;
        Write(ClaudeProtocol.InterruptJson());
        return true;
    }

    void Write(string line)
    {
        if (!IsRunning) return;
        try { _process.StandardInput.Write(line); _process.StandardInput.Flush(); } catch { }
    }

    TurnResult Fail()
    {
        string detail;
        lock (_stderrGate) detail = _stderr.ToString();
        detail = detail.Trim();
        var lower = detail.ToLowerInvariant();
        string[] loginMarkers = { "/login", "not logged in", "please log in", "authenticat", "oauth", "invalid api key" };
        var msg = loginMarkers.Any(lower.Contains)
            ? "Claude Code isn't signed in. Run `claude` in a terminal and log in, then try again."
            : detail.Length == 0 ? "Claude Code stopped unexpectedly." : "Claude Code: " + detail[^Math.Min(300, detail.Length)..];
        throw new ClaudeException(msg);
    }

    void OnExited()
    {
        // Finalization happens on stdout EOF (OnStdoutClosed). Here we only log.
        if (_tcs is not null) Log.Write($"claude exited mid-turn ({SafeExitCode()})");
    }

    int SafeExitCode() { try { return _process.ExitCode; } catch { return -1; } }

    void Finish(TurnResult r) { var t = _tcs; _tcs = null; _onEvent = null; t?.TrySetResult(r); }
    void FinishError(Exception e) { var t = _tcs; _tcs = null; _onEvent = null; t?.TrySetException(e); }

    public void Close()
    {
        try { _process.StandardInput.Close(); } catch { }
        try { if (IsRunning) _process.Kill(entireProcessTree: true); } catch { }
    }

    public void Dispose() { Close(); _process.Dispose(); }
}

public class ClaudeException : Exception
{
    public ClaudeException(string message) : base(message) { }
}
