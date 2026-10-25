using Dash.Core;
using Xunit;

public class ChatStoreTests : IDisposable
{
    readonly string _dir = Path.Combine(Path.GetTempPath(), "dash-test-" + Guid.NewGuid().ToString("N"));
    ChatStore Store() => new(_dir);
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    static ChatDocument Doc(string id, string title)
    {
        var now = DateTime.UtcNow;
        return new ChatDocument
        {
            Meta = new ChatMeta(id, title, "sess-" + id, now, now, "opus", "high", null),
            Turns = new() { new ChatTurn { Role = TurnRole.User, Text = "hi" } },
        };
    }

    [Fact]
    public void Save_then_load_round_trips()
    {
        var s = Store();
        s.Save(Doc("a", "First"));
        var loaded = s.Load("a");
        Assert.Equal("First", loaded!.Meta.Title);
        Assert.Equal("hi", loaded.Turns[0].Text);
    }

    [Fact]
    public void List_returns_saved_chats()
    {
        var s = Store();
        s.Save(Doc("a", "A"));
        s.Save(Doc("b", "B"));
        Assert.Equal(2, s.List().Count);
    }

    [Fact]
    public void Rename_and_delete_update_index()
    {
        var s = Store();
        s.Save(Doc("a", "A"));
        s.Rename("a", "Renamed");
        Assert.Equal("Renamed", s.List().Single().Title);
        s.Delete("a");
        Assert.Empty(s.List());
    }

    [Fact]
    public void Corrupt_document_is_quarantined_not_thrown()
    {
        var s = Store();
        s.Save(Doc("a", "A"));
        File.WriteAllText(Path.Combine(_dir, "a.json"), "{ not json");
        Assert.Null(s.Load("a"));
        Assert.True(File.Exists(Path.Combine(_dir, "a.json.corrupt")));
    }
}
