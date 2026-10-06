using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace TrayApplication;

// A battery reading as the panel shows it. Null Percent means the device did not report a level.
internal sealed record BatteryStatus(int? Percent, bool Charging, string? Note = null);

internal static class BluetoothBattery
{
    private const int CrSuccess = 0;
    private const int CmGetIdListFilterEnumerator = 1;
    private static readonly DevPropKey FriendlyName =
        new(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);
    private static readonly DevPropKey IsConnected =
        new(new Guid("83da6326-97a6-4088-9453-a1923f573b29"), 15);
    private static readonly DevPropKey Battery =
        new(new Guid("104ea319-6ee2-4701-bd47-8ddbf425bbe5"), 2);

    // Returns null when no paired device has this name or it is not connected.
    public static BatteryStatus? Read(string deviceName)
    {
        var ids = DeviceIds("BTHENUM");
        var device = ids.FirstOrDefault(id =>
            id.StartsWith(@"BTHENUM\DEV_", StringComparison.OrdinalIgnoreCase)
            && ReadString(id, FriendlyName) == deviceName
        );
        if (device is null || ReadBytes(device, IsConnected) is not [not 0]) return null;

        // The level lives on one of the device's profile nodes, which all embed its address.
        var address = device.Split('\\')[1]["DEV_".Length..];
        var level = ids
            .Where(id => id.Contains(address, StringComparison.OrdinalIgnoreCase))
            .Select(id => ReadBytes(id, Battery))
            .FirstOrDefault(value => value is [_]);
        return new BatteryStatus(level?[0], false);
    }

    private static string[] DeviceIds(string enumerator)
    {
        if (CM_Get_Device_ID_List_Size(out var length, enumerator, CmGetIdListFilterEnumerator) != CrSuccess)
            return [];
        var buffer = new char[length];
        if (CM_Get_Device_ID_List(enumerator, buffer, length, CmGetIdListFilterEnumerator) != CrSuccess)
            return [];
        return new string(buffer).Split('\0', StringSplitOptions.RemoveEmptyEntries);
    }

    private static string? ReadString(string id, DevPropKey key) =>
        ReadBytes(id, key) is { } bytes
            ? System.Text.Encoding.Unicode.GetString(bytes).TrimEnd('\0')
            : null;

    private static byte[]? ReadBytes(string id, DevPropKey key)
    {
        if (CM_Locate_DevNode(out var node, id, 0) != CrSuccess) return null;
        var size = 0;
        CM_Get_DevNode_Property(node, ref key, out _, null, ref size, 0);
        if (size == 0) return null;
        var buffer = new byte[size];
        return CM_Get_DevNode_Property(node, ref key, out _, buffer, ref size, 0) == CrSuccess
            ? buffer
            : null;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DevPropKey(Guid category, int id)
    {
        public Guid Category = category;
        public int Id = id;
    }

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, EntryPoint = "CM_Get_Device_ID_List_SizeW")]
    private static extern int CM_Get_Device_ID_List_Size(out int length, string filter, int flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, EntryPoint = "CM_Get_Device_ID_ListW")]
    private static extern int CM_Get_Device_ID_List(string filter, char[] buffer, int length, int flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, EntryPoint = "CM_Locate_DevNodeW")]
    private static extern int CM_Locate_DevNode(out int node, string id, int flags);

    [DllImport("cfgmgr32.dll", EntryPoint = "CM_Get_DevNode_PropertyW")]
    private static extern int CM_Get_DevNode_Property(
        int node,
        ref DevPropKey key,
        out int type,
        byte[]? buffer,
        ref int size,
        int flags
    );
}

internal static class DjiMic
{
    public const int BusyRetryInterval = 30_000;

    // Returns null when the receiver is unplugged or no transmitter is on.
    // Busy is true when DJI Mic Control holds the receiver, since WinUSB allows one process at a time.
    public static async Task<(BatteryStatus? Status, bool Busy)> ReadAsync(string command)
    {
        var start = new ProcessStartInfo(command, "status --json")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        Process process;
        try
        {
            process = Process.Start(start)!;
        }
        catch (Win32Exception)
        {
            return (null, false);
        }

        using (process)
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill();
                return (null, false);
            }

            return Parse(process.ExitCode, await output, await error);
        }
    }

    public static (BatteryStatus? Status, bool Busy) Parse(int exitCode, string output, string error)
    {
        if (exitCode != 0)
        {
            return error.Contains("connected but not accessible")
                ? (new BatteryStatus(null, false, "DJI app open"), true)
                : (null, false);
        }

        using var json = JsonDocument.Parse(output);
        var root = json.RootElement;
        if (!root.TryGetProperty("connected", out var connected) || !connected.GetBoolean())
            return (null, false);

        // Two transmitter slots, null when that transmitter is off. The panel shows the first one on.
        var transmitter = root.GetProperty("tx").EnumerateArray()
            .FirstOrDefault(slot => slot.ValueKind == JsonValueKind.Object);
        if (transmitter.ValueKind != JsonValueKind.Object) return (null, false);

        // The gauge runs from 1 (full) to 7 (empty).
        int? percent = transmitter.TryGetProperty("battery", out var gauge) && gauge.ValueKind == JsonValueKind.Number
            ? (int)Math.Round((7 - gauge.GetInt32()) / 6.0 * 100)
            : null;
        var charging = transmitter.TryGetProperty("charging", out var dock) && dock.ValueKind == JsonValueKind.True;
        return (new BatteryStatus(percent, charging), false);
    }
}
