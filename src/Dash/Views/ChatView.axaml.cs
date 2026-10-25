using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Dash.Core;

namespace Dash.Views;

public partial class ChatView : UserControl
{
    public ChatView() { InitializeComponent(); }

    async void OnInputKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && !e.KeyModifiers.HasFlag(KeyModifiers.Shift))
        {
            e.Handled = true;
            if (DataContext is ChatConversation c && sender is TextBox tb)
            {
                var text = tb.Text ?? "";
                tb.Text = "";
                await c.SendAsync(text);
            }
        }
    }

    void OnStop(object? sender, RoutedEventArgs e)
    {
        if (DataContext is ChatConversation c) c.Stop();
    }
}
