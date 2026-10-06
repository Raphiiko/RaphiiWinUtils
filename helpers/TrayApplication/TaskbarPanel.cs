using Microsoft.Win32;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Net.Http.Json;
using System.Runtime.InteropServices;

namespace TrayApplication;

// A per-pixel-alpha child window of Shell_TrayWnd, just left of the notification area.
// A cross-process child shares an input queue with explorer, so the panel must run on its own
// thread that never blocks: a stall here freezes taskbar input too.
internal sealed class TaskbarPanel : NativeWindow
{
    private const int TrackInterval = 1000;
    private const int ModeInterval = 2000;
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

    public event Action? LeftButtonDown;
    public event Action? Clicked;
    public event Action? ExitRequested;

    private readonly Icon icon;
    private readonly Uri modesUri;
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly System.Windows.Forms.Timer trackTimer = new() { Interval = TrackInterval };
    private readonly System.Windows.Forms.Timer modeTimer = new() { Interval = ModeInterval };
    // Runs only while hovered, to notice the cursor leaving the panel.
    private readonly System.Windows.Forms.Timer hoverTimer = new() { Interval = 50 };
    private readonly ContextMenuStrip menu = new();
    private IntPtr taskbar;
    private Rectangle anchor;
    private string label = "";
    private bool hovered;
    private bool lightTheme;

    public TaskbarPanel(Icon icon, Uri baseUri)
    {
        this.icon = icon;
        modesUri = new Uri(baseUri, "/audio/modes");
        menu.Items.Add("Exit", null, (_, _) => ExitRequested?.Invoke());
        // RefreshSoon marshals through the menu, so its handle must exist on this thread.
        _ = menu.Handle;
        trackTimer.Tick += (_, _) => Track();
        hoverTimer.Tick += (_, _) =>
        {
            if (GetCursorPos(out var cursor) && WindowFromPoint(cursor) == Handle) return;
            hoverTimer.Stop();
            hovered = false;
            Render();
        };
        modeTimer.Tick += async (_, _) => await RefreshModeAsync();
        trackTimer.Start();
        modeTimer.Start();
        Track();
        _ = RefreshModeAsync();
    }

    // Starts the panel on a dedicated STA thread. Events are raised on that thread.
    public static TaskbarPanel Start(Icon icon, Uri baseUri)
    {
        var created = new TaskCompletionSource<TaskbarPanel>();
        var thread = new Thread(() =>
        {
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            created.SetResult(new TaskbarPanel(icon, baseUri));
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
        string next;
        try
        {
            var state = await http.GetFromJsonAsync<ModesResponse>(modesUri);
            next = state?.Modes.FirstOrDefault(mode => mode.Id == state.Active)?.Name ?? "";
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            next = "";
        }

        var light = Registry.GetValue(
            @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "SystemUsesLightTheme",
            0
        ) is 1;
        if (next == label && light == lightTheme) return;
        label = next;
        lightTheme = light;
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

    private void Render()
    {
        if (anchor.Height == 0) return;
        var scale = GetDpiForWindow(Handle) / 96f;
        var padding = (int)(10 * scale);
        var iconSize = (int)(20 * scale);
        var gap = (int)(8 * scale);
        using var font = new Font("Segoe UI", 12 * scale, GraphicsUnit.Pixel);
        var textWidth = label.Length == 0
            ? 0
            : TextRenderer.MeasureText(label, font).Width;
        var width = padding * 2 + iconSize + (textWidth > 0 ? gap + textWidth : 0);
        var height = anchor.Height;

        using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            // Alpha 0 pixels are click-through on a layered window, so the background is never fully clear.
            graphics.Clear(Color.FromArgb(1, 0, 0, 0));
            var inset = (int)(4 * scale);
            if (hovered)
            {
                using var hover = new SolidBrush(
                    lightTheme ? Color.FromArgb(20, 0, 0, 0) : Color.FromArgb(24, 255, 255, 255)
                );
                using var path = RoundedRectangle(
                    new Rectangle(0, inset, width - 1, height - inset * 2 - 1),
                    (int)(4 * scale)
                );
                graphics.FillPath(hover, path);
            }

            using (var sized = new Icon(icon, iconSize, iconSize))
            {
                graphics.DrawIcon(
                    sized,
                    new Rectangle(padding, (height - iconSize) / 2, iconSize, iconSize)
                );
            }

            if (textWidth > 0)
            {
                using var brush = new SolidBrush(lightTheme ? Color.Black : Color.White);
                using var format = new StringFormat { LineAlignment = StringAlignment.Center };
                graphics.DrawString(
                    label,
                    font,
                    brush,
                    new RectangleF(padding + iconSize + gap, 0, textWidth + gap, height),
                    format
                );
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
                anchor.X - width,
                anchor.Y,
                width,
                height,
                SwpNoActivate | SwpShowWindow
            );
            var size = new NativeSize { Width = width, Height = height };
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
            case WmMouseMove when !hovered:
                hovered = true;
                hoverTimer.Start();
                Render();
                break;
            case WmLButtonDown:
                LeftButtonDown?.Invoke();
                break;
            case WmLButtonUp:
                Clicked?.Invoke();
                break;
            case WmRButtonUp:
                menu.Show(Cursor.Position);
                break;
        }

        base.WndProc(ref message);
    }

    private sealed record ModesResponse(List<ModeSummary> Modes, string? Active);

    private sealed record ModeSummary(string Id, string Name);

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
