namespace Dash.Core;

public static class DashPaths
{
    public static string Root { get; } = EnsureDir(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Dash"));
    public static string ChatsDir => EnsureDir(Path.Combine(Root, "chats"));
    /// <summary>Empty working directory for the claude child, kept apart from Dash's chats and log.</summary>
    public static string WorkDir => EnsureDir(Path.Combine(Root, "work"));
    public static string LogFile => Path.Combine(Root, "dash.log");

    static string EnsureDir(string p) { Directory.CreateDirectory(p); return p; }
}
