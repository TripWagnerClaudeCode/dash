using Avalonia.Controls;
using Dash.Core;
using Dash.ViewModels;

namespace Dash;

public partial class MainWindow : Window
{
    public MainWindow() { InitializeComponent(); }

    void OnChatSelected(object? sender, SelectionChangedEventArgs e)
    {
        if (DataContext is AppViewModel vm && sender is ListBox { SelectedItem: ChatMeta meta })
            vm.OpenCommand.Execute(meta);
    }
}
