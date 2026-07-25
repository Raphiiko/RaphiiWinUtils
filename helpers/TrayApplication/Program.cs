using Microsoft.Web.WebView2.WinForms;

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
            Icon = SystemIcons.Application,
            Text = "RaphiiWinUtils",
            Visible = true,
            ContextMenuStrip = new ContextMenuStrip()
        };
        icon.ContextMenuStrip.Items.Add("Exit", null, (_, _) => ExitThread());
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
}

internal sealed class DashboardPopup : Form
{
    private const int PopupWidth = 900;
    private const int PopupHeight = 700;
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill };
    private readonly string url;

    public DashboardPopup(string url)
    {
        this.url = url;
        Controls.Add(browser);
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(PopupWidth, PopupHeight);
        Deactivate += (_, _) => Hide();
    }

    public async void Toggle()
    {
        if (Visible)
        {
            Hide();
            return;
        }

        var area = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(area.Right - PopupWidth - 12, area.Bottom - PopupHeight - 12);
        Show();
        Activate();

        if (browser.Source is null)
        {
            await browser.EnsureCoreWebView2Async();
            browser.Source = new Uri(url);
        }
    }
}
