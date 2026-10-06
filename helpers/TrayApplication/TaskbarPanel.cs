using Microsoft.Win32;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace TrayApplication;

// A per-pixel-alpha child window of Shell_TrayWnd, just left of the notification area.
// A cross-process child shares an input queue with explorer, so the panel must run on its own
// thread that never blocks: a stall here freezes taskbar input too.
internal sealed class TaskbarPanel : NativeWindow
{
    private const int TrackInterval = 1000;
    private const int ModeInterval = 2000;
    private const int DeviceInterval = 10_000;
    private const int WsChild = 0x40000000;
    private const int WsClipSiblings = 0x04000000;
    private const int WsExLayered = 0x00080000;
    private const int WsExNoActivate = 0x08000000;
    private const int WmMouseMove = 0x0200;
    private const int WmLButtonDown = 0x0201;
    private const int WmLButtonUp = 0x0202;
    private const int WmRButtonUp = 0x0205;
    private const int WmMouseActivate = 0x0021;
    private const int MaNoActivate = 3;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpShowWindow = 0x0040;
    private const string HeadphoneGlyph = "";
    private const string MicrophoneGlyph = "";
    private const string ChargingGlyph = "";

    public event Action? LeftButtonDown;
    // Carries the dashboard view the clicked section opens, such as "#audio".
    public event Action<string>? Clicked;
    public event Action? ExitRequested;

    private readonly Icon icon;
    private readonly Uri modesUri;
    private readonly string earbudsName;
    private readonly string djiMicCommand;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly System.Windows.Forms.Timer trackTimer = new() { Interval = TrackInterval };
    private readonly System.Windows.Forms.Timer modeTimer = new() { Interval = ModeInterval };
    private readonly System.Windows.Forms.Timer earbudsTimer = new() { Interval = DeviceInterval };
    private readonly System.Windows.Forms.Timer lavMicTimer = new() { Interval = DeviceInterval };
    // Runs only while hovered, to notice the cursor leaving the panel.
    private readonly System.Windows.Forms.Timer hoverTimer = new() { Interval = 50 };
    private readonly ContextMenuStrip menu = new();
    private IntPtr taskbar;
    private Rectangle anchor;
    private Section[] sections = [];
    private int hovered = -1;
    private string modeName = "";
    private string micName = "";
    private BatteryStatus? earbuds;
    private BatteryStatus? lavMic;
    private bool lavMicReading;
    private bool lightTheme;

    public TaskbarPanel(Icon icon, Uri baseUri, string earbudsName, string djiMicCommand)
    {
        this.icon = icon;
        this.earbudsName = earbudsName;
        this.djiMicCommand = djiMicCommand;
        modesUri = new Uri(baseUri, "/audio/modes");
        menu.Items.Add("Exit", null, (_, _) => ExitRequested?.Invoke());
        // RefreshSoon marshals through the menu, so its handle must exist on this thread.
        _ = menu.Handle;
        trackTimer.Tick += (_, _) => Track();
        hoverTimer.Tick += (_, _) =>
        {
            if (GetCursorPos(out var cursor) && WindowFromPoint(cursor) == Handle) return;
            hoverTimer.Stop();
            SetHovered(-1);
        };
        modeTimer.Tick += async (_, _) => await RefreshModeAsync();
        earbudsTimer.Tick += async (_, _) => await RefreshEarbudsAsync();
        lavMicTimer.Tick += async (_, _) => await RefreshLavMicAsync();
        trackTimer.Start();
        modeTimer.Start();
        Track();
        _ = RefreshModeAsync();
        if (earbudsName.Length > 0)
        {
            earbudsTimer.Start();
            _ = RefreshEarbudsAsync();
        }

        if (djiMicCommand.Length > 0)
        {
            lavMicTimer.Start();
            _ = RefreshLavMicAsync();
        }
    }

    // Starts the panel on a dedicated STA thread. Events are raised on that thread.
    public static TaskbarPanel Start(Icon icon, Uri baseUri, string earbudsName, string djiMicCommand)
    {
        var created = new TaskCompletionSource<TaskbarPanel>();
        var thread = new Thread(() =>
        {
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            created.SetResult(new TaskbarPanel(icon, baseUri, earbudsName, djiMicCommand));
            Application.Run();
        })
        {
            IsBackground = true,
            Name = "TaskbarPanel"
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return created.Task.Result;
    }

    public void RefreshSoon() => menu.BeginInvoke(() => _ = RefreshModeAsync());

    private async Task RefreshModeAsync()
    {
        string mode, mic;
        try
        {
            var state = await http.GetFromJsonAsync<ModesResponse>(modesUri);
            mode = state?.Modes.FirstOrDefault(item => item.Id == state.Active)?.Name ?? "";
            mic = state?.Mics.FirstOrDefault(item => item.Id == state.ActiveMic)?.Name ?? "";
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            mode = "";
            mic = "";
        }

        var light = Registry.GetValue(
            @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "SystemUsesLightTheme",
            0
        ) is 1;
        if (mode == modeName && mic == micName && light == lightTheme) return;
        modeName = mode;
        micName = mic;
        lightTheme = light;
        Render();
    }

    private async Task RefreshEarbudsAsync()
    {
        var next = await Task.Run(() => BluetoothBattery.Read(earbudsName));
        if (next == earbuds) return;
        earbuds = next;
        Render();
    }

    private async Task RefreshLavMicAsync()
    {
        // djimic must never run twice at once: the receiver accepts one client.
        if (lavMicReading) return;
        lavMicReading = true;
        BatteryStatus? next;
        bool busy;
        try
        {
            (next, busy) = await DjiMic.ReadAsync(djiMicCommand);
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            Console.Error.WriteLine($"Could not read djimic status: {error.Message}");
            (next, busy) = (null, false);
        }
        finally
        {
            lavMicReading = false;
        }

        lavMicTimer.Interval = busy ? DjiMic.BusyRetryInterval : DeviceInterval;
        if (next == lavMic) return;
        lavMic = next;
        Render();
    }

    // Explorer restarts replace Shell_TrayWnd, and tray icons move the notification area,
    // so both are rechecked instead of trusting the first lookup.
    private void Track()
    {
        var tray = FindWindow("Shell_TrayWnd", null);
        if (tray == IntPtr.Zero) return;
        // Explorer destroys the panel together with the old taskbar, so it is created again.
        if (tray != taskbar || !IsWindow(Handle))
        {
            if (Handle != IntPtr.Zero) DestroyHandle();
            CreateHandle(
                new CreateParams
                {
                    Caption = "RaphiiWinUtils",
                    Parent = tray,
                    Style = WsChild | WsClipSiblings,
                    ExStyle = WsExLayered | WsExNoActivate
                }
            );
            taskbar = tray;
            anchor = Rectangle.Empty;
        }

        var notify = FindWindowEx(tray, IntPtr.Zero, "TrayNotifyWnd", null);
        if (notify == IntPtr.Zero || !GetWindowRect(notify, out var area)) return;
        MapWindowPoints(IntPtr.Zero, tray, ref area, 2);
        var next = new Rectangle(area.Left, area.Top, 0, area.Bottom - area.Top);
        if (next == anchor)
        {
            // The taskbar reorders its own children, so the panel is raised again on every check.
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
            return;
        }

        anchor = next;
        Render();
    }

    private void SetHovered(int index)
    {
        if (index == hovered) return;
        hovered = index;
        Render();
    }

    private void Render()
    {
        if (anchor.Height == 0) return;
        var scale = GetDpiForWindow(Handle) / 96f;
        var height = anchor.Height;
        var padding = (int)(10 * scale);
        var gap = (int)(6 * scale);
        var iconSize = (int)(20 * scale);
        using var font = new Font("Segoe UI", 12 * scale, GraphicsUnit.Pixel);
        using var small = new Font("Segoe UI", 11 * scale, GraphicsUnit.Pixel);
        using var glyphs = new Font("Segoe Fluent Icons", 14 * scale, GraphicsUnit.Pixel);
        using var smallGlyphs = new Font("Segoe Fluent Icons", 11 * scale, GraphicsUnit.Pixel);
        using var measure = Graphics.FromHwnd(IntPtr.Zero);
        int Width(string text, Font with) =>
            text.Length == 0
                ? 0
                : (int)Math.Ceiling(
                    measure.MeasureString(text, with, PointF.Empty, StringFormat.GenericTypographic).Width
                );

        var foreground = lightTheme ? Color.Black : Color.White;
        var dim = Color.FromArgb(170, foreground);
        var list = new List<Section>
        {
            new(
                "#home",
                padding * 2 + iconSize,
                (graphics, bounds) =>
                {
                    using var sized = new Icon(icon, iconSize, iconSize);
                    graphics.DrawIcon(
                        sized,
                        new Rectangle(bounds.X + padding, (height - iconSize) / 2, iconSize, iconSize)
                    );
                }
            )
        };

        if (modeName.Length > 0 || micName.Length > 0)
        {
            var width = Math.Max(Width(modeName, font), Width(micName, small));
            list.Add(
                new(
                    "#audio",
                    padding * 2 + width,
                    (graphics, bounds) =>
                    {
                        var middle = height / 2f;
                        DrawText(graphics, modeName, font, foreground, bounds.X + padding, middle - font.Height, font.Height);
                        DrawText(graphics, micName, small, dim, bounds.X + padding, middle, small.Height);
                    }
                )
            );
        }

        foreach (var (glyph, status) in new[] { (HeadphoneGlyph, earbuds), (MicrophoneGlyph, lavMic) })
        {
            if (status is null) continue;
            var text = status.Note ?? (status.Percent is { } percent ? $"{percent}%" : "?");
            var glyphWidth = Width(glyph, glyphs);
            var textWidth = Width(text, font);
            var chargeWidth = status.Charging ? Width(ChargingGlyph, smallGlyphs) : 0;
            list.Add(
                new(
                    "#home",
                    padding * 2 + glyphWidth + gap + textWidth + chargeWidth,
                    (graphics, bounds) =>
                    {
                        var x = bounds.X + padding;
                        DrawText(graphics, glyph, glyphs, foreground, x, 0, height);
                        x += glyphWidth + gap;
                        DrawText(graphics, text, font, foreground, x, 0, height);
                        if (status.Charging)
                            DrawText(graphics, ChargingGlyph, smallGlyphs, foreground, x + textWidth, 0, height);
                    }
                )
            );
        }

        // The panel grows leftward from the tray, so the optional sections go first
        // and the static ones keep their position when a device comes or goes.
        list.Reverse();
        sections = [.. list];
        var total = sections.Sum(section => section.Width);
        using var bitmap = new Bitmap(total, height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            // Alpha 0 pixels are click-through on a layered window, so the background is never fully clear.
            graphics.Clear(Color.FromArgb(1, 0, 0, 0));
            var inset = (int)(4 * scale);
            var x = 0;
            for (var index = 0; index < sections.Length; index++)
            {
                var bounds = new Rectangle(x, 0, sections[index].Width, height);
                if (index == hovered)
                {
                    using var hover = new SolidBrush(
                        lightTheme ? Color.FromArgb(20, 0, 0, 0) : Color.FromArgb(24, 255, 255, 255)
                    );
                    using var path = RoundedRectangle(
                        new Rectangle(bounds.X, inset, bounds.Width - 1, height - inset * 2 - 1),
                        (int)(4 * scale)
                    );
                    graphics.FillPath(hover, path);
                }

                sections[index].Draw(graphics, bounds);
                x += bounds.Width;
            }
        }

        var screen = GetDC(IntPtr.Zero);
        var memory = CreateCompatibleDC(screen);
        var hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
        var previous = SelectObject(memory, hBitmap);
        try
        {
            SetWindowPos(
                Handle,
                IntPtr.Zero,
                anchor.X - total,
                anchor.Y,
                total,
                height,
                SwpNoActivate | SwpShowWindow
            );
            var size = new NativeSize { Width = total, Height = height };
            var source = new NativePoint();
            var blend = new BlendFunction { SourceConstantAlpha = 255, AlphaFormat = 1 };
            UpdateLayeredWindow(Handle, screen, IntPtr.Zero, ref size, memory, ref source, 0, ref blend, 2);
        }
        finally
        {
            SelectObject(memory, previous);
            DeleteObject(hBitmap);
            DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    private static void DrawText(
        Graphics graphics,
        string text,
        Font font,
        Color color,
        float x,
        float y,
        float height
    )
    {
        using var brush = new SolidBrush(color);
        using var format = new StringFormat(StringFormat.GenericTypographic)
        {
            LineAlignment = StringAlignment.Center,
            FormatFlags = StringFormatFlags.NoWrap
        };
        graphics.DrawString(text, font, brush, new RectangleF(x, y, 10_000, height), format);
    }

    private int SectionAt(IntPtr lParam)
    {
        var x = (short)(lParam.ToInt64() & 0xFFFF);
        for (var index = 0; index < sections.Length; index++)
        {
            if (x < sections[index].Width) return index;
            x -= (short)sections[index].Width;
        }

        return -1;
    }

    private static GraphicsPath RoundedRectangle(Rectangle rectangle, int radius)
    {
        var diameter = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
        path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    protected override void WndProc(ref Message message)
    {
        switch (message.Msg)
        {
            case WmMouseActivate:
                message.Result = MaNoActivate;
                return;
            case WmMouseMove:
                hoverTimer.Start();
                SetHovered(SectionAt(message.LParam));
                break;
            case WmLButtonDown:
                LeftButtonDown?.Invoke();
                break;
            case WmLButtonUp when SectionAt(message.LParam) is var index and >= 0:
                Clicked?.Invoke(sections[index].View);
                break;
            case WmRButtonUp:
                menu.Show(Cursor.Position);
                break;
        }

        base.WndProc(ref message);
    }

    private sealed record Section(string View, int Width, Action<Graphics, Rectangle> Draw);

    private sealed record ModesResponse(
        List<NamedItem> Modes,
        string? Active,
        List<NamedItem> Mics,
        string? ActiveMic
    );

    private sealed record NamedItem(string Id, string Name);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSize
    {
        public int Width, Height;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BlendFunction
    {
        public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string? windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string? windowName);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);

    [DllImport("user32.dll")]
    private static extern int MapWindowPoints(IntPtr from, IntPtr to, ref NativeRect rect, int count);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out NativePoint point);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(NativePoint point);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern bool UpdateLayeredWindow(
        IntPtr window,
        IntPtr destination,
        IntPtr destinationPoint,
        ref NativeSize size,
        IntPtr source,
        ref NativePoint sourcePoint,
        int colorKey,
        ref BlendFunction blend,
        int flags
    );

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr window, IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr dc, IntPtr item);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr item);
}
