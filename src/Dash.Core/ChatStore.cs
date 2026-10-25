using System.Text.Json;

namespace Dash.Core;

public class ChatStore
{
    readonly string _dir;
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public ChatStore(string rootDir) { _dir = rootDir; Directory.CreateDirectory(_dir); }

    string IndexPath => Path.Combine(_dir, "index.json");
    string DocPath(string id) => Path.Combine(_dir, id + ".json");

    public List<ChatMeta> List()
    {
        if (!File.Exists(IndexPath)) return new();
        try { return JsonSerializer.Deserialize<List<ChatMeta>>(File.ReadAllText(IndexPath)) ?? new(); }
        catch { Quarantine(IndexPath); return new(); }
    }

    void WriteIndex(List<ChatMeta> metas)
    {
        try { File.WriteAllText(IndexPath, JsonSerializer.Serialize(metas, Json)); }
        catch (Exception e) { Log.Write("index write failed: " + e.Message); }
    }

    public ChatDocument? Load(string id)
    {
        var path = DocPath(id);
        if (!File.Exists(path)) return null;
        try { return JsonSerializer.Deserialize<ChatDocument>(File.ReadAllText(path)); }
        catch { Quarantine(path); return null; }
    }

    public void Save(ChatDocument doc)
    {
        try { File.WriteAllText(DocPath(doc.Meta.Id), JsonSerializer.Serialize(doc, Json)); }
        catch (Exception e) { Log.Write("chat write failed: " + e.Message); return; }
        var metas = List();
        metas.RemoveAll(m => m.Id == doc.Meta.Id);
        metas.Add(doc.Meta);
        WriteIndex(metas.OrderByDescending(m => m.UpdatedAt).ToList());
    }

    public void Rename(string id, string title)
    {
        var metas = List();
        var i = metas.FindIndex(m => m.Id == id);
        if (i < 0) return;
        metas[i] = metas[i] with { Title = title, UpdatedAt = DateTime.UtcNow };
        WriteIndex(metas);
        var doc = Load(id);
        if (doc is not null) { doc.Meta = metas[i]; Save(doc); }
    }

    public void Delete(string id)
    {
        try { File.Delete(DocPath(id)); } catch { }
        WriteIndex(List().Where(m => m.Id != id).ToList());
    }

    static void Quarantine(string path)
    {
        try { File.Move(path, path + ".corrupt", overwrite: true); Log.Write("quarantined " + path); } catch { }
    }
}
