namespace Dash.Core;

public static class Log
{
    static readonly object Gate = new();
    public static void Write(string msg)
    {
        try { lock (Gate) File.AppendAllText(DashPaths.LogFile, $"{DateTime.Now:s} {msg}\n"); }
        catch { /* logging must never throw */ }
    }
}
