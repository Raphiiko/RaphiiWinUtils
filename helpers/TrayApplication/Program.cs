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
    private readonly TaskbarPanel panel;
    private readonly DashboardPopup popup;

    public TrayContext(string url)
    {
        popup = new DashboardPopup(url);
        var ui = SynchronizationContext.Current!;
        panel = TaskbarPanel.Start(LoadTrayIcon(), new Uri(url));
        panel.ExitRequested += () => ui.Post(_ =>
        {
            Environment.ExitCode = 42;
            ExitThread();
        }, null);
        panel.LeftButtonDown += () => ui.Post(_ => popup.SuppressNextDeactivate(), null);
        panel.Clicked += () => ui.Post(_ => popup.Toggle(), null);
        popup.VisibleChanged += (_, _) =>
        {
            if (!popup.Visible) panel.RefreshSoon();
        };
    }

    protected override void ExitThreadCore()
    {
        // ponytail: the panel thread is a background thread, process exit destroys its window.
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

    public void Toggle()
    {
        if (Visible)
        {
            HideWithAnimation();
            return;
        }

        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Size = new Size(
            Math.Min(PopupWidth, area.Width - PopupMargin * 2),
            Math.Min(PopupHeight, area.Height - PopupMargin * 2)
        );
        Location = new Point(area.Right - Width - PopupMargin, area.Bottom - Height - PopupMargin);
        ShowWithAnimation();
        _ = ResetToHomeWhenReadyAsync();
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
        browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
        browser.CoreWebView2.ProcessFailed += (_, eventArgs) =>
        {
            Console.Error.WriteLine($"WebView process failed: {eventArgs.ProcessFailedKind}");
            Environment.Exit(1);
        };
        browser.Source = new Uri(url);
    }

    private Task ResetToHomeAsync()
    {
        return browser.CoreWebView2.ExecuteScriptAsync(
            "location.hash = '#home'; window.scrollTo(0, 0);"
        );
    }

    private async Task ResetToHomeWhenReadyAsync()
    {
        try
        {
            await browserInitialization.WaitAsync(TimeSpan.FromSeconds(10));
            if (IsDisposed) return;
            await ResetToHomeAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Dashboard reset failed: {error}");
            if (!IsDisposed) Environment.Exit(1);
        }
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
