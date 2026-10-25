using System;
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Dash.Core;

namespace Dash.ViewModels;

public partial class AppViewModel : ObservableObject
{
    readonly ChatStore _store = new(DashPaths.ChatsDir);

    public ObservableCollection<ChatMeta> Chats { get; } = new();
    [ObservableProperty] ChatConversation? _active;

    public AppViewModel()
    {
        foreach (var m in _store.List()) Chats.Add(m);
        if (Chats.Count > 0) Open(Chats[0]);
        else NewChat();
    }

    [RelayCommand]
    public void NewChat()
    {
        var now = DateTime.UtcNow;
        var doc = new ChatDocument
        {
            Meta = new ChatMeta(Guid.NewGuid().ToString("N"), "New chat", null, now, now,
                ClaudeModel.DefaultId, "high", null),
        };
        _store.Save(doc);
        Chats.Insert(0, doc.Meta);
        Active = new ChatConversation(doc, _store);
    }

    [RelayCommand]
    public void Open(ChatMeta meta)
    {
        var doc = _store.Load(meta.Id) ?? new ChatDocument { Meta = meta };
        Active = new ChatConversation(doc, _store);
    }

    [RelayCommand]
    public void DeleteChat(ChatMeta meta)
    {
        _store.Delete(meta.Id);
        Chats.Remove(meta);
        if (Active?.Meta.Id == meta.Id) { if (Chats.Count > 0) Open(Chats[0]); else NewChat(); }
    }
}
