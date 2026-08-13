using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;
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
    private const int IconRefreshDelay = 2000;
    private readonly NotifyIcon icon;
    private readonly DashboardPopup popup;
    private readonly System.Windows.Forms.Timer iconRefreshTimer =
        new() { Interval = IconRefreshDelay };

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
        iconRefreshTimer.Tick += (_, _) =>
        {
            iconRefreshTimer.Stop();
            RefreshIcon();
        };
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
    }

    // Turning every monitor off drops the icon from the shell, and the shell does not
    // send TaskbarCreated when they come back. Only a fresh Shell_NotifyIcon add returns it.
    private void OnDisplaySettingsChanged(object? sender, EventArgs eventArgs)
    {
        // SystemEvents raises this off the UI thread, and NotifyIcon is not thread safe.
        try
        {
            popup.BeginInvoke(() =>
            {
                iconRefreshTimer.Stop();
                iconRefreshTimer.Start();
            });
        }
        catch (Exception error) when (error is ObjectDisposedException or InvalidOperationException)
        {
            // The popup is gone because the app is exiting. There is no icon left to refresh.
        }
    }

    private void RefreshIcon()
    {
        icon.Visible = false;
        icon.Visible = true;
    }

    protected override void ExitThreadCore()
    {
        SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
        iconRefreshTimer.Dispose();
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
    private const int PopupWidth = 1020;
    private const int PopupHeight = 788;
    private const int PopupMargin = 4;
    private const int DwmWindowCornerPreference = 33;
    private const int DwmWindowCornerPreferenceRound = 2;
    private const int WsBorder = 0x00800000;
    private const int CsDropShadow = 0x00020000;
    private const int PopupAnimationDuration = 140;
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer animationTimer = new() { Interval = 15 };
    private readonly Task browserInitialization;
    private readonly string url;
    private DateTime animationStarted;
    private double animationStartOpacity;
    private double animationTargetOpacity;
    private bool hideAfterAnimation;
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
        animationTimer.Tick += (_, _) => UpdateAnimation();
        Disposed += (_, _) => animationTimer.Dispose();
        CreateControl();
        browser.CreateControl();
        browserInitialization = InitializeBrowserAsync();
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

        await browserInitialization;
        await ResetToHomeAsync();

        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Size = new Size(
            Math.Min(PopupWidth, area.Width - PopupMargin * 2),
            Math.Min(PopupHeight, area.Height - PopupMargin * 2)
        );
        Location = new Point(area.Right - Width - PopupMargin, area.Bottom - Height - PopupMargin);
        ShowWithAnimation();
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr hwnd,
        int attribute,
        ref int value,
        int valueSize
    );

    private void ShowWithAnimation()
    {
        animationTimer.Stop();
        Opacity = 0;
        Show();
        Activate();
        StartAnimation(1, false);
    }

    private void HideWithAnimation()
    {
        if (!Visible || hideAfterAnimation) return;
        StartAnimation(0, true);
    }

    private async Task InitializeBrowserAsync()
    {
        await browser.EnsureCoreWebView2Async();
        browser.Source = new Uri(url);
    }

    private Task ResetToHomeAsync()
    {
        return browser.CoreWebView2.ExecuteScriptAsync(
            "location.hash = '#home'; window.scrollTo(0, 0);"
        );
    }

    private void StartAnimation(double targetOpacity, bool hideWhenComplete)
    {
        animationTimer.Stop();
        animationStarted = DateTime.UtcNow;
        animationStartOpacity = Opacity;
        animationTargetOpacity = targetOpacity;
        hideAfterAnimation = hideWhenComplete;
        animationTimer.Start();
    }

    private void UpdateAnimation()
    {
        var progress = Math.Min(
            1,
            (DateTime.UtcNow - animationStarted).TotalMilliseconds / PopupAnimationDuration
        );
        Opacity = animationStartOpacity + (animationTargetOpacity - animationStartOpacity) * progress;
        if (progress < 1) return;

        animationTimer.Stop();
        if (!hideAfterAnimation) return;

        Hide();
        Opacity = 1;
        hideAfterAnimation = false;
    }
}
