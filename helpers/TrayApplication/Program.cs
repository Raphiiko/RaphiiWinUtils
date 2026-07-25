using Microsoft.Web.WebView2.WinForms;
using System.Runtime.InteropServices;

namespace TrayApplication;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext(args.FirstOrDefault() ?? "http://127.0.0.1:17642"));
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly DashboardPopup popup;

    public TrayContext(string url)
    {
        popup = new DashboardPopup(url);
        icon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = "RaphiiWinUtils",
            Visible = true,
            ContextMenuStrip = new ContextMenuStrip()
        };
        icon.ContextMenuStrip.Items.Add("Exit", null, (_, _) => ExitThread());
        icon.MouseDown += (_, eventArgs) =>
        {
            if (eventArgs.Button == MouseButtons.Left) popup.SuppressNextDeactivate();
        };
        icon.MouseUp += (_, eventArgs) =>
        {
            if (eventArgs.Button == MouseButtons.Left) popup.Toggle();
        };
    }

    protected override void ExitThreadCore()
    {
        icon.Visible = false;
        icon.Dispose();
        popup.Dispose();
        base.ExitThreadCore();
    }

    private static Icon LoadTrayIcon()
    {
        const string resourceName = "TrayApplication.Assets.tray-icon.ico";
        using var stream = typeof(TrayContext).Assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Missing tray icon resource: {resourceName}");
        using var source = new Icon(stream);
        return (Icon)source.Clone();
    }
}

internal sealed class DashboardPopup : Form
{
    private const int PopupWidth = 1000;
    private const int PopupHeight = 780;
    private const int PopupMargin = 8;
    private const int DwmWindowCornerPreference = 33;
    private const int DwmWindowCornerPreferenceRound = 2;
    private const int WsBorder = 0x00800000;
    private const int CsDropShadow = 0x00020000;
    private const int PopupAnimationDuration = 140;
    private const int AwHide = 0x00010000;
    private const int AwActivate = 0x00020000;
    private const int AwBlend = 0x00080000;
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly string url;
    private bool suppressNextDeactivate;

    public DashboardPopup(string url)
    {
        this.url = url;
        Controls.Add(browser);
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(PopupWidth, PopupHeight);
        Deactivate += (_, _) => BeginInvoke(HideUnlessSuppressed);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.Style |= WsBorder;
            parameters.ClassStyle |= CsDropShadow;
            return parameters;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        var cornerPreference = DwmWindowCornerPreferenceRound;
        DwmSetWindowAttribute(Handle, DwmWindowCornerPreference, ref cornerPreference, sizeof(int));
    }

    public void SuppressNextDeactivate()
    {
        suppressNextDeactivate = Visible;
    }

    private void HideUnlessSuppressed()
    {
        if (suppressNextDeactivate)
        {
            suppressNextDeactivate = false;
            return;
        }

        HideWithAnimation();
    }

    public async void Toggle()
    {
        if (Visible)
        {
            HideWithAnimation();
            return;
        }

        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.Right - Width - PopupMargin, area.Bottom - Height - PopupMargin);
        ShowWithAnimation();

        if (browser.Source is null)
        {
            await browser.EnsureCoreWebView2Async();
            browser.Source = new Uri(url);
        }
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr hwnd,
        int attribute,
        ref int value,
        int valueSize
    );

    [DllImport("user32.dll")]
    private static extern bool AnimateWindow(IntPtr handle, int duration, int flags);

    private void ShowWithAnimation()
    {
        if (!AnimateWindow(Handle, PopupAnimationDuration, AwActivate | AwBlend)) Show();
    }

    private void HideWithAnimation()
    {
        if (!AnimateWindow(Handle, PopupAnimationDuration, AwHide | AwBlend)) Hide();
    }
}
