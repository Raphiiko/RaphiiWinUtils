using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;

// Reports which application holds the foreground, and sends keystrokes to it.
//
// Stdout is NDJSON:
//   {"type":"foreground","process":"photoshop","title":"a.psd @ 66%","pid":1234}
//   {"type":"error","message":"..."}
// Stdin is NDJSON:
//   {"type":"hotkey","keys":"ctrl+shift+m"}
//
// A window's title changes without the foreground changing (Photoshop rewrites
// it on every zoom and document switch), so both events are hooked. A slow
// fallback poll covers a hook event that never arrives.
internal static class Program
{
    [STAThread]
    public static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        using var form = new ForegroundWatcherForm();
        var stdinThread = new Thread(form.ReadCommands)
        {
            IsBackground = true,
            Name = "ForegroundWatcher stdin"
        };
        stdinThread.Start();

        Application.Run(form);
    }
}

internal sealed class ForegroundWatcherForm : Form
{
    private const uint EventSystemForeground = 0x0003;
    private const uint EventObjectNameChange = 0x800C;
    private const uint WineventOutOfContext = 0x0000;
    private const int FallbackPollMs = 2000;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly object writeLock = new();
    private readonly System.Windows.Forms.Timer fallbackPollTimer = new();
    private readonly WinEventDelegate hookCallback;
    private IntPtr foregroundHook;
    private IntPtr nameChangeHook;
    private string? lastProcess;
    private string? lastTitle;
    private int lastPid;

    public ForegroundWatcherForm()
    {
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        Opacity = 0;
        ShowInTaskbar = false;
        Size = new Size(0, 0);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-32000, -32000);

        // The delegate must outlive the hook: a collected callback crashes the
        // process the next time Windows raises the event.
        hookCallback = OnWinEvent;
        fallbackPollTimer.Interval = FallbackPollMs;
        fallbackPollTimer.Tick += (_, _) => Publish();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        foregroundHook = SetWinEventHook(EventSystemForeground, EventSystemForeground, IntPtr.Zero,
            hookCallback, 0, 0, WineventOutOfContext);
        nameChangeHook = SetWinEventHook(EventObjectNameChange, EventObjectNameChange, IntPtr.Zero,
            hookCallback, 0, 0, WineventOutOfContext);
        fallbackPollTimer.Start();
        Publish();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        fallbackPollTimer.Stop();
        if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
        if (nameChangeHook != IntPtr.Zero) UnhookWinEvent(nameChangeHook);
        base.OnFormClosed(e);
    }

    private void OnWinEvent(IntPtr hook, uint eventType, IntPtr window, int objectId, int childId,
        uint threadId, uint timestamp)
    {
        // A name change on any other window says nothing about the foreground.
        if (eventType == EventObjectNameChange && window != GetForegroundWindow()) return;
        Publish();
    }

    private void Publish()
    {
        try
        {
            var window = GetForegroundWindow();
            var process = ProcessNameOf(window, out var pid);
            var title = TitleOf(window);
            if (process == lastProcess && title == lastTitle && pid == lastPid) return;
            lastProcess = process;
            lastTitle = title;
            lastPid = pid;
            Write(new { type = "foreground", process, title, pid });
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
        }
    }

    private static string? ProcessNameOf(IntPtr window, out int pid)
    {
        pid = 0;
        if (window == IntPtr.Zero) return null;
        GetWindowThreadProcessId(window, out var raw);
        if (raw == 0) return null;
        pid = (int)raw;
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName.ToLowerInvariant();
        }
        catch
        {
            // The process can exit between the two calls, and protected system
            // processes refuse the open outright. Neither is worth reporting.
            return null;
        }
    }

    private static string? TitleOf(IntPtr window)
    {
        if (window == IntPtr.Zero) return null;
        var length = GetWindowTextLength(window);
        if (length <= 0) return null;
        var buffer = new StringBuilder(length + 1);
        GetWindowText(window, buffer, buffer.Capacity);
        var title = buffer.ToString();
        return title.Length == 0 ? null : title;
    }

    public void ReadCommands()
    {
        try
        {
            string? line;
            while ((line = Console.ReadLine()) is not null)
            {
                var captured = line;
                BeginInvoke(() => HandleCommand(captured));
            }
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
        }
        finally
        {
            BeginInvoke(Close);
        }
    }

    private void HandleCommand(string line)
    {
        if (line.Length == 0) return;
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var type) || type.GetString() != "hotkey") return;
            if (!root.TryGetProperty("keys", out var keys)) return;
            var combo = keys.GetString();
            if (string.IsNullOrWhiteSpace(combo)) return;
            SendHotkey(combo);
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
        }
    }

    private void SendHotkey(string combo)
    {
        if (!HotkeyParser.TryParse(combo, out var modifiers, out var key))
        {
            Write(new { type = "error", message = $"Unknown key combination: {combo}" });
            return;
        }

        // Modifiers down, key down, key up, modifiers up in reverse: the order a
        // physical press produces, which is what applications expect.
        var inputs = new List<INPUT>();
        foreach (var modifier in modifiers) inputs.Add(KeyInput(modifier, false));
        inputs.Add(KeyInput(key, false));
        inputs.Add(KeyInput(key, true));
        for (var i = modifiers.Count - 1; i >= 0; i--) inputs.Add(KeyInput(modifiers[i], true));

        var array = inputs.ToArray();
        var sent = SendInput((uint)array.Length, array, Marshal.SizeOf<INPUT>());
        if (sent != array.Length)
        {
            Write(new { type = "error", message = $"SendInput sent {sent} of {array.Length} events" });
        }
    }

    private static INPUT KeyInput(ushort virtualKey, bool up) => new()
    {
        type = 1, // INPUT_KEYBOARD
        u = new INPUTUNION
        {
            ki = new KEYBDINPUT
            {
                wVk = virtualKey,
                wScan = 0,
                dwFlags = up ? 0x0002u : 0u, // KEYEVENTF_KEYUP
                time = 0,
                dwExtraInfo = IntPtr.Zero
            }
        }
    };

    private void Write(object payload)
    {
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        lock (writeLock)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    private delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr window, int objectId,
        int childId, uint threadId, uint timestamp);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module,
        WinEventDelegate callback, uint processId, uint threadId, uint flags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
}

internal static class HotkeyParser
{
    private static readonly Dictionary<string, ushort> Modifiers = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ctrl"] = 0xA2,     // VK_LCONTROL
        ["control"] = 0xA2,
        ["alt"] = 0xA4,      // VK_LMENU
        ["shift"] = 0xA0,    // VK_LSHIFT
        ["win"] = 0x5B       // VK_LWIN
    };

    private static readonly Dictionary<string, ushort> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["space"] = 0x20,
        ["enter"] = 0x0D,
        ["return"] = 0x0D,
        ["tab"] = 0x09,
        ["escape"] = 0x1B,
        ["esc"] = 0x1B,
        ["backspace"] = 0x08,
        ["delete"] = 0x2E,
        ["up"] = 0x26,
        ["down"] = 0x28,
        ["left"] = 0x25,
        ["right"] = 0x27,
        ["["] = 0xDB,
        ["]"] = 0xDD,
        ["lbracket"] = 0xDB,
        ["rbracket"] = 0xDD,
        [","] = 0xBC,
        ["."] = 0xBE,
        ["/"] = 0xBF,
        [";"] = 0xBA,
        ["'"] = 0xDE,
        ["-"] = 0xBD,
        ["="] = 0xBB,
        ["`"] = 0xC0,
        ["\\"] = 0xDC
    };

    // "ctrl+shift+m" → modifiers [VK_LCONTROL, VK_LSHIFT], key VK_M.
    public static bool TryParse(string combo, out List<ushort> modifiers, out ushort key)
    {
        modifiers = [];
        key = 0;
        var parts = combo.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return false;

        for (var i = 0; i < parts.Length; i++)
        {
            var part = parts[i];
            var last = i == parts.Length - 1;
            if (!last)
            {
                if (!Modifiers.TryGetValue(part, out var modifier)) return false;
                if (!modifiers.Contains(modifier)) modifiers.Add(modifier);
                continue;
            }
            if (!TryParseKey(part, out key)) return false;
        }

        return key != 0;
    }

    private static bool TryParseKey(string part, out ushort key)
    {
        key = 0;
        if (Named.TryGetValue(part, out key)) return true;
        if (part.Length == 1)
        {
            var c = char.ToUpperInvariant(part[0]);
            if (c is >= 'A' and <= 'Z' or >= '0' and <= '9')
            {
                key = c;
                return true;
            }
            return false;
        }
        if (part.Length is 2 or 3 && (part[0] is 'f' or 'F') &&
            int.TryParse(part.AsSpan(1), out var n) && n is >= 1 and <= 24)
        {
            key = (ushort)(0x70 + n - 1); // VK_F1
            return true;
        }
        return false;
    }
}
