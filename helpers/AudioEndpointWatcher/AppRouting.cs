using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

internal sealed record AppSession(
    string Path,
    string Name,
    DateTime? StartedAt,
    string? PinnedEndpointId,
    string[] ActiveEndpointIds,
    float Peak);

// Per-app output devices, as in Settings > Sound > Volume mixer. Windows stores the choice per
// executable path, so it also applies to later launches of the same app.
internal static class AppRouting
{
    private static readonly object Gate = new();
    private static readonly Dictionary<string, string> Names = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, string?> Icons = new(StringComparer.OrdinalIgnoreCase);
    private static HashSet<string> knownPaths = new(StringComparer.OrdinalIgnoreCase);

    public static AppSession[] List()
    {
        lock (Gate)
        {
            var apps = Collect();
            knownPaths = apps.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase);
            return apps.Values.Select(app => app.ToSession()).ToArray();
        }
    }

    public static void SetEndpoint(string path, string? endpointId)
    {
        lock (Gate)
        {
            if (!Collect().TryGetValue(path, out var app))
                throw new ArgumentException($"App is not playing audio: {path}");

            var deviceId = string.IsNullOrEmpty(endpointId)
                ? null
                : $@"\\?\SWD#MMDEVAPI#{endpointId}#{{e6327cad-dcec-4949-ae8a-991e976a79d2}}";
            foreach (var processId in app.ProcessIds)
            {
                PolicyConfigFactory.SetEndpoint(processId, Role.Multimedia, deviceId);
                PolicyConfigFactory.SetEndpoint(processId, Role.Console, deviceId);
            }
        }
    }

    /// <summary>A PNG of the executable's icon, or null when it has none.</summary>
    public static string? IconBase64(string path)
    {
        lock (Gate)
        {
            if (!knownPaths.Contains(path)) throw new ArgumentException($"Unknown app: {path}");
            if (Icons.TryGetValue(path, out var cached)) return cached;

            string? png = null;
            try
            {
                using var icon = Icon.ExtractIcon(path, 0, 64) ?? Icon.ExtractAssociatedIcon(path);
                if (icon is not null)
                {
                    using var bitmap = icon.ToBitmap();
                    using var stream = new MemoryStream();
                    bitmap.Save(stream, ImageFormat.Png);
                    png = Convert.ToBase64String(stream.ToArray());
                }
            }
            catch (Exception ex) when (ex is ArgumentException or IOException or ExternalException)
            {
                // No icon; the dashboard falls back to the app's initial.
            }
            Icons[path] = png;
            return png;
        }
    }

    private static Dictionary<string, AppBuilder> Collect()
    {
        var apps = new Dictionary<string, AppBuilder>(StringComparer.OrdinalIgnoreCase);
        var processes = new Dictionary<uint, (string Path, DateTime? StartedAt)?>();
        using var enumerator = new MMDeviceEnumerator();
        foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (device)
            {
                var sessions = device.AudioSessionManager.Sessions;
                for (var index = 0; index < sessions.Count; index++)
                {
                    using var session = sessions[index];
                    if (session.IsSystemSoundsSession) continue;
                    if (session.State == AudioSessionState.AudioSessionStateExpired) continue;

                    var processId = session.GetProcessID;
                    if (!processes.TryGetValue(processId, out var process))
                        processes[processId] = process = ProcessInfo.Read(processId);
                    if (process is not { } info) continue;

                    if (!apps.TryGetValue(info.Path, out var app))
                    {
                        app = new AppBuilder(info.Path, DisplayName(info.Path));
                        apps[info.Path] = app;
                    }
                    app.Add(processId, info.StartedAt, session, device.ID);
                }
            }
        }
        return apps;
    }

    private static string DisplayName(string path)
    {
        if (Names.TryGetValue(path, out var cached)) return cached;
        string? name = null;
        try
        {
            var version = FileVersionInfo.GetVersionInfo(path);
            name = new[] { version.FileDescription, version.ProductName }
                .Select(value => value?.Trim())
                .FirstOrDefault(value => !string.IsNullOrEmpty(value));
        }
        catch (FileNotFoundException)
        {
        }
        return Names[path] = name ?? System.IO.Path.GetFileNameWithoutExtension(path);
    }

    private sealed class AppBuilder(string path, string name)
    {
        public readonly List<uint> ProcessIds = [];
        private readonly HashSet<string> activeEndpointIds = [];
        private DateTime? startedAt;
        private float peak;

        public void Add(uint processId, DateTime? processStartedAt, AudioSessionControl session, string endpointId)
        {
            if (!ProcessIds.Contains(processId)) ProcessIds.Add(processId);
            if (processStartedAt < startedAt || startedAt is null) startedAt = processStartedAt;
            if (session.State == AudioSessionState.AudioSessionStateActive)
            {
                activeEndpointIds.Add(endpointId);
                peak = Math.Max(peak, session.AudioMeterInformation.MasterPeakValue);
            }
        }

        public AppSession ToSession() => new(
            path,
            name,
            startedAt,
            PolicyConfigFactory.GetEndpoint(ProcessIds[0]),
            [.. activeEndpointIds],
            peak);
    }
}

internal static class ProcessInfo
{
    private const uint QueryLimitedInformation = 0x1000;

    public static (string Path, DateTime? StartedAt)? Read(uint processId)
    {
        var handle = OpenProcess(QueryLimitedInformation, false, processId);
        if (handle == IntPtr.Zero) return null;
        try
        {
            var buffer = new char[1024];
            var length = buffer.Length;
            if (!QueryFullProcessImageName(handle, 0, buffer, ref length)) return null;
            DateTime? startedAt = GetProcessTimes(handle, out var created, out _, out _, out _)
                ? DateTime.FromFileTimeUtc(created)
                : null;
            return (new string(buffer, 0, length), startedAt);
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, char[] name, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}

// Undocumented WinRT factory behind the Settings app's per-app device picker. The vtable slots
// below are only valid for the interface GUID requested here (Windows 10 21H2 and later).
internal static unsafe class PolicyConfigFactory
{
    private const int SetSlot = 25;
    private const int GetSlot = 26;
    private static IntPtr factory;

    public static void SetEndpoint(uint processId, Role role, string? deviceId)
    {
        var text = CreateString(deviceId);
        try
        {
            var set = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, int, IntPtr, int>)Slot(SetSlot);
            Marshal.ThrowExceptionForHR(set(Factory(), processId, (int)DataFlow.Render, (int)role, text));
        }
        finally
        {
            if (text != IntPtr.Zero) WindowsDeleteString(text);
        }
    }

    /// <summary>The pinned endpoint ID in MMDevice form, or null when the app follows the default.</summary>
    public static string? GetEndpoint(uint processId)
    {
        var get = (delegate* unmanaged[Stdcall]<IntPtr, uint, int, int, IntPtr*, int>)Slot(GetSlot);
        IntPtr text;
        if (get(Factory(), processId, (int)DataFlow.Render, (int)Role.Multimedia, &text) != 0) return null;
        if (text == IntPtr.Zero) return null;
        try
        {
            var raw = WindowsGetStringRawBuffer(text, out var length);
            var deviceId = Marshal.PtrToStringUni(raw, (int)length);
            // \\?\SWD#MMDEVAPI#{0.0.0.00000000}.{guid}#{interface class}
            var parts = deviceId.Split('#');
            return parts.Length >= 3 ? parts[2] : null;
        }
        finally
        {
            WindowsDeleteString(text);
        }
    }

    private static IntPtr Slot(int index) => (*(IntPtr**)Factory())[index];

    private static IntPtr Factory()
    {
        if (factory != IntPtr.Zero) return factory;
        var className = CreateString("Windows.Media.Internal.AudioPolicyConfig");
        try
        {
            var iid = new Guid("ab3d4648-e242-459f-b02f-541c70306324");
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(className, ref iid, out factory));
            return factory;
        }
        finally
        {
            WindowsDeleteString(className);
        }
    }

    private static IntPtr CreateString(string? value)
    {
        if (string.IsNullOrEmpty(value)) return IntPtr.Zero;
        Marshal.ThrowExceptionForHR(WindowsCreateString(value, value.Length, out var text));
        return text;
    }

    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    private static extern int WindowsCreateString(string value, int length, out IntPtr text);

    [DllImport("combase.dll")]
    private static extern int WindowsDeleteString(IntPtr text);

    [DllImport("combase.dll")]
    private static extern IntPtr WindowsGetStringRawBuffer(IntPtr text, out uint length);

    [DllImport("combase.dll")]
    private static extern int RoGetActivationFactory(IntPtr className, ref Guid iid, out IntPtr factory);
}
