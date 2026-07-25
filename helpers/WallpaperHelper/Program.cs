using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

internal static class Program
{
    private const int ExifOrientationId = 0x0112;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            object result = (args.Length > 0 ? args[0] : "") switch
            {
                "monitors" => new { monitors = ListMonitors() },
                "apply" => Apply(ReadPlan()),
                var command => throw new ArgumentException(
                    $"Unknown command '{command}'. Usage: WallpaperHelper.exe monitors|apply")
            };
            Write(result);
            return 0;
        }
        catch (Exception ex)
        {
            Write(new { error = ex.Message });
            return 1;
        }
    }

    private static List<MonitorInfo> ListMonitors()
    {
        var desktop = CreateDesktopWallpaper();
        // Three panels can share one model name, so the EDID friendly name and the connector are
        // the only way a human tells them apart. An empty map means the CCD query failed; fall back
        // to listing everything rather than showing no monitors at all.
        var active = DisplayPaths.QueryActiveTargets();
        var monitors = new List<MonitorInfo>();
        var count = desktop.GetMonitorDevicePathCount();
        for (uint index = 0; index < count; index++)
        {
            var id = desktop.GetMonitorDevicePathAt(index);
            if (string.IsNullOrEmpty(id)) continue;
            if (active.Count > 0 && !active.ContainsKey(id)) continue;

            Rect rect;
            try
            {
                rect = desktop.GetMonitorRECT(id);
            }
            catch (COMException)
            {
                // The shell keeps reporting device paths for monitors that are no longer attached.
                continue;
            }

            active.TryGetValue(id, out var target);
            monitors.Add(new MonitorInfo(
                id,
                rect.Left,
                rect.Top,
                rect.Right - rect.Left,
                rect.Bottom - rect.Top,
                string.IsNullOrWhiteSpace(target.Name) ? "Display" : target.Name,
                target.Connector ?? "unknown"));
        }

        return monitors;
    }

    private static object Apply(Plan plan)
    {
        if (plan.Assignments.Count == 0) throw new ArgumentException("Plan contains no assignments");
        Directory.CreateDirectory(plan.CacheDir);

        var desktop = CreateDesktopWallpaper();
        var applied = new List<object>();
        var errors = new List<object>();

        foreach (var assignment in plan.Assignments)
        {
            try
            {
                var rect = desktop.GetMonitorRECT(assignment.MonitorId);
                var target = new Size(rect.Right - rect.Left, rect.Bottom - rect.Top);
                var (path, reused) = RenderCrop(assignment, target, plan.CacheDir);
                desktop.SetWallpaper(assignment.MonitorId, path);
                applied.Add(new
                {
                    monitorId = assignment.MonitorId,
                    path,
                    reused,
                    width = target.Width,
                    height = target.Height
                });
            }
            catch (Exception ex)
            {
                errors.Add(new { monitorId = assignment.MonitorId, error = ex.Message });
            }
        }

        // Every image is already cropped to its monitor's native size, so Fill is a no-op today and
        // stays sane if the monitor resolution changes before the next apply.
        desktop.SetPosition(DesktopWallpaperPosition.Fill);
        return new { applied, errors };
    }

    private static (string Path, bool Reused) RenderCrop(Assignment assignment, Size target, string cacheDir)
    {
        var source = new FileInfo(assignment.Source);
        if (!source.Exists) throw new FileNotFoundException($"Source image not found: {assignment.Source}");
        if (target.Width < 1 || target.Height < 1) throw new InvalidOperationException("Monitor reported an empty rect");

        // Content-addressed output name. Windows caches the transcoded wallpaper per path, so a
        // changed crop has to land on a new path or the desktop keeps showing the previous image.
        var key = Hash(string.Join(
            '|',
            source.FullName.ToLowerInvariant(),
            source.LastWriteTimeUtc.Ticks,
            source.Length,
            $"{assignment.Crop.X},{assignment.Crop.Y},{assignment.Crop.Width},{assignment.Crop.Height}",
            $"{target.Width}x{target.Height}"));
        var outPath = Path.Combine(cacheDir, $"{key}.png");
        if (File.Exists(outPath)) return (outPath, true);

        using var stream = File.OpenRead(source.FullName);
        using var image = Image.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: false);
        NormalizeOrientation(image);

        var crop = ClampCrop(assignment.Crop, image.Width, image.Height);
        using var bitmap = new Bitmap(target.Width, target.Height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.DrawImage(
                image,
                new Rectangle(0, 0, target.Width, target.Height),
                crop.X,
                crop.Y,
                crop.Width,
                crop.Height,
                GraphicsUnit.Pixel);
        }

        // Write beside the target then move, so a crash mid-encode cannot leave a truncated file
        // that the content hash would happily reuse forever.
        var tempPath = $"{outPath}.{Environment.ProcessId}.tmp";
        bitmap.Save(tempPath, ImageFormat.Png);
        File.Move(tempPath, outPath, overwrite: true);
        return (outPath, false);
    }

    private static void NormalizeOrientation(Image image)
    {
        if (Array.IndexOf(image.PropertyIdList, ExifOrientationId) < 0) return;

        var raw = image.GetPropertyItem(ExifOrientationId)?.Value;
        if (raw is null || raw.Length < 2) return;

        // Browsers auto-orient when the cropper measures the image, so GDI+ has to match or every
        // crop on a phone photo lands rotated.
        var flip = BitConverter.ToUInt16(raw, 0) switch
        {
            2 => RotateFlipType.RotateNoneFlipX,
            3 => RotateFlipType.Rotate180FlipNone,
            4 => RotateFlipType.Rotate180FlipX,
            5 => RotateFlipType.Rotate90FlipX,
            6 => RotateFlipType.Rotate90FlipNone,
            7 => RotateFlipType.Rotate270FlipX,
            8 => RotateFlipType.Rotate270FlipNone,
            _ => RotateFlipType.RotateNoneFlipNone
        };
        if (flip == RotateFlipType.RotateNoneFlipNone) return;

        image.RotateFlip(flip);
        image.RemovePropertyItem(ExifOrientationId);
    }

    private static Rectangle ClampCrop(CropRect crop, int width, int height)
    {
        var x = Math.Clamp(crop.X, 0, Math.Max(0, width - 1));
        var y = Math.Clamp(crop.Y, 0, Math.Max(0, height - 1));
        return new Rectangle(
            x,
            y,
            Math.Clamp(crop.Width, 1, width - x),
            Math.Clamp(crop.Height, 1, height - y));
    }

    private static Plan ReadPlan()
    {
        var payload = Console.In.ReadToEnd();
        return JsonSerializer.Deserialize<Plan>(payload, JsonOptions)
               ?? throw new ArgumentException("Plan payload was empty");
    }

    private static IDesktopWallpaper CreateDesktopWallpaper()
    {
        var type = Type.GetTypeFromCLSID(new Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD"))
                   ?? throw new InvalidOperationException("DesktopWallpaper COM class is unavailable");
        return (IDesktopWallpaper)(Activator.CreateInstance(type)
                                   ?? throw new InvalidOperationException("Failed to create DesktopWallpaper"));
    }

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..24].ToLowerInvariant();

    private static void Write(object message)
    {
        Console.WriteLine(JsonSerializer.Serialize(message, JsonOptions));
        Console.Out.Flush();
    }
}

internal sealed record MonitorInfo(
    string Id,
    int X,
    int Y,
    int Width,
    int Height,
    string Name,
    string Connector);

internal readonly record struct ActiveTarget(string Name, string Connector);

/// <summary>
/// Connected Display Configuration lookup. IDesktopWallpaper alone reports device paths for
/// monitors the shell merely remembers, and it never reports names or connectors.
/// </summary>
internal static class DisplayPaths
{
    private const uint OnlyActivePaths = 2;
    private const uint GetTargetName = 2;

    public static Dictionary<string, ActiveTarget> QueryActiveTargets()
    {
        var targets = new Dictionary<string, ActiveTarget>(StringComparer.OrdinalIgnoreCase);
        if (GetDisplayConfigBufferSizes(OnlyActivePaths, out var pathCount, out var modeCount) != 0)
        {
            return targets;
        }

        var paths = new PathInfo[pathCount];
        var modes = new ModeInfo[modeCount];
        if (QueryDisplayConfig(OnlyActivePaths, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero) != 0)
        {
            return targets;
        }

        for (var index = 0; index < pathCount; index++)
        {
            var request = new TargetDeviceName
            {
                Header = new DeviceInfoHeader
                {
                    Type = GetTargetName,
                    Size = (uint)Marshal.SizeOf<TargetDeviceName>(),
                    AdapterId = paths[index].TargetInfo.AdapterId,
                    Id = paths[index].TargetInfo.Id
                }
            };
            if (DisplayConfigGetDeviceInfo(ref request) != 0) continue;
            if (string.IsNullOrEmpty(request.MonitorDevicePath)) continue;

            targets[request.MonitorDevicePath] = new ActiveTarget(
                request.MonitorFriendlyDeviceName.Trim(),
                Connector(request.OutputTechnology));
        }

        return targets;
    }

    private static string Connector(uint technology) => technology switch
    {
        0 => "VGA",
        1 => "S-Video",
        2 => "Composite",
        3 => "Component",
        4 => "DVI",
        5 => "HDMI",
        6 => "LVDS",
        8 => "D-Jpn",
        9 => "SDI",
        10 => "DisplayPort",
        11 => "DisplayPort",
        12 => "UDI",
        13 => "UDI",
        15 => "Internal",
        0x80000000 => "Internal",
        _ => "unknown"
    };

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rational
    {
        public uint Numerator;
        public uint Denominator;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathSourceInfo
    {
        public Luid AdapterId;
        public uint Id;
        public uint ModeInfoIdx;
        public uint StatusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathTargetInfo
    {
        public Luid AdapterId;
        public uint Id;
        public uint ModeInfoIdx;
        public uint OutputTechnology;
        public uint Rotation;
        public uint Scaling;
        public Rational RefreshRate;
        public uint ScanLineOrdering;
        public int TargetAvailable;
        public uint StatusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PathInfo
    {
        public PathSourceInfo SourceInfo;
        public PathTargetInfo TargetInfo;
        public uint Flags;
    }

    // Only the size matters here; the mode array is required by the API but never read.
    [StructLayout(LayoutKind.Sequential, Size = 64)]
    private struct ModeInfo
    {
        public uint InfoType;
        public uint Id;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInfoHeader
    {
        public uint Type;
        public uint Size;
        public Luid AdapterId;
        public uint Id;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TargetDeviceName
    {
        public DeviceInfoHeader Header;
        public uint Flags;
        public uint OutputTechnology;
        public ushort EdidManufactureId;
        public ushort EdidProductCodeId;
        public uint ConnectorInstance;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string MonitorFriendlyDeviceName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string MonitorDevicePath;
    }

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);

    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(
        uint flags,
        ref uint pathCount,
        [Out] PathInfo[] paths,
        ref uint modeCount,
        [Out] ModeInfo[] modes,
        IntPtr topology);

    [DllImport("user32.dll")]
    private static extern int DisplayConfigGetDeviceInfo(ref TargetDeviceName request);
}

internal sealed record CropRect(int X, int Y, int Width, int Height);

internal sealed record Assignment(string MonitorId, string Source, CropRect Crop);

internal sealed record Plan(string CacheDir, List<Assignment> Assignments);

[StructLayout(LayoutKind.Sequential)]
internal struct Rect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

internal enum DesktopWallpaperPosition
{
    Center = 0,
    Tile = 1,
    Stretch = 2,
    Fit = 3,
    Fill = 4,
    Span = 5
}

// Declared in vtable order and truncated after GetPosition; the slideshow and status members are
// unused here and must not be appended out of order.
[ComImport]
[Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDesktopWallpaper
{
    void SetWallpaper(
        [MarshalAs(UnmanagedType.LPWStr)] string monitorId,
        [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);

    [return: MarshalAs(UnmanagedType.LPWStr)]
    string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorId);

    [return: MarshalAs(UnmanagedType.LPWStr)]
    string GetMonitorDevicePathAt(uint monitorIndex);

    uint GetMonitorDevicePathCount();

    Rect GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorId);

    void SetBackgroundColor(uint color);

    uint GetBackgroundColor();

    void SetPosition(DesktopWallpaperPosition position);

    DesktopWallpaperPosition GetPosition();
}
