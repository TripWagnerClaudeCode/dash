namespace Dash.Core;

public static class DashPaths
{
    public static string Root { get; } = EnsureDir(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Dash"));
    public static string ChatsDir => EnsureDir(Path.Combine(Root, "chats"));
    public static string LogFile => Path.Combine(Root, "dash.log");

    static string EnsureDir(string p) { Directory.CreateDirectory(p); return p; }
}
