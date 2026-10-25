using System;
using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;
using Dash.Core;

namespace Dash.Converters;

public class RoleBackgroundConverter : IValueConverter
{
    public object Convert(object? v, Type t, object? p, CultureInfo c) =>
        v is TurnRole.User ? new SolidColorBrush(Color.Parse("#2d2d33"))
                           : new SolidColorBrush(Color.Parse("#1b1b1f"));
    public object ConvertBack(object? v, Type t, object? p, CultureInfo c) => throw new NotSupportedException();
}
