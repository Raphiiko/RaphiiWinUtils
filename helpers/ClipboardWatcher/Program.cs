using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    public static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        using var form = new ClipboardWatcherForm();
        var stdinThread = new Thread(form.ReadCommands)
        {
            IsBackground = true,
            Name = "ClipboardWatcher stdin"
        };
        stdinThread.Start();

        Application.Run(form);
    }
}

internal sealed class ClipboardWatcherForm : Form
{
    private const int WmClipboardUpdate = 0x031D;
    private const int ClipboardRetryCount = 10;
    private const int ClipboardRetryDelayMs = 50;
    private const int FallbackPollMs = 1000;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly object writeLock = new();
    private readonly System.Windows.Forms.Timer fallbackPollTimer = new();
    private string? lastWrittenText;
    private string? lastPublishedText;

    public ClipboardWatcherForm()
    {
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        Opacity = 0;
        ShowInTaskbar = false;
        Size = new Size(0, 0);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-32000, -32000);
        fallbackPollTimer.Interval = FallbackPollMs;
        fallbackPollTimer.Tick += (_, _) => PublishClipboardText();
    }

    public void ReadCommands()
    {
        try
        {
            string? line;
            while ((line = Console.ReadLine()) is not null)
            {
                BeginInvoke(() => HandleCommand(line));
            }
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
        }
        finally
        {
            try
            {
                BeginInvoke(Application.ExitThread);
            }
            catch
            {
                // The UI thread may already be exiting.
            }
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (!NativeMethods.AddClipboardFormatListener(Handle))
        {
            Write(new { type = "error", message = "AddClipboardFormatListener failed" });
            return;
        }

        Write(new { type = "ready" });
        PublishClipboardText();
        fallbackPollTimer.Start();
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        fallbackPollTimer.Stop();
        NativeMethods.RemoveClipboardFormatListener(Handle);
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmClipboardUpdate)
        {
            PublishClipboardText();
        }

        base.WndProc(ref message);
    }

    private void HandleCommand(string line)
    {
        try
        {
            var command = JsonSerializer.Deserialize<ClipboardCommand>(line, JsonOptions);
            if (command?.Type == "setText" && command.Content is not null)
            {
                SetClipboardText(command.Content);
            }
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
        }
    }

    private void PublishClipboardText()
    {
        var content = TryClipboardOperation(() =>
        {
            if (!Clipboard.ContainsText(TextDataFormat.UnicodeText)) return null;
            return Clipboard.GetText(TextDataFormat.UnicodeText);
        });

        if (content is null || content == lastWrittenText) return;
        if (content == lastPublishedText) return;
        lastPublishedText = content;
        Write(new { type = "text", content });
    }

    private void SetClipboardText(string content)
    {
        TryClipboardOperation<object?>(() =>
        {
            Clipboard.SetText(content, TextDataFormat.UnicodeText);
            lastWrittenText = content;
            lastPublishedText = content;
            return null;
        });
    }

    private T? TryClipboardOperation<T>(Func<T?> operation)
    {
        for (var attempt = 1; attempt <= ClipboardRetryCount; attempt++)
        {
            try
            {
                return operation();
            }
            catch (ExternalException) when (attempt < ClipboardRetryCount)
            {
                Thread.Sleep(ClipboardRetryDelayMs);
            }
            catch (ThreadStateException) when (attempt < ClipboardRetryCount)
            {
                Thread.Sleep(ClipboardRetryDelayMs);
            }
        }

        try
        {
            return operation();
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
            return default;
        }
    }

    private void Write(object message)
    {
        lock (writeLock)
        {
            Console.WriteLine(JsonSerializer.Serialize(message, JsonOptions));
            Console.Out.Flush();
        }
    }
}

internal sealed record ClipboardCommand(string Type, string? Content);

internal static class NativeMethods
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
}
