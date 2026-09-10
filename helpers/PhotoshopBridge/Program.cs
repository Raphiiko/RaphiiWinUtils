using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

// Reads and writes Photoshop's brush through its COM automation interface, and
// plays saved Actions by name.
//
// Stdin is NDJSON:
//   {"type":"read"}
//   {"type":"set","diameter":137,"angle":42}      both fields required
//   {"type":"action","set":"Kipfel","name":"Toggle Symmetry"}
// Stdout is NDJSON:
//   {"type":"brush","diameter":400,"angle":0}
//   {"type":"unavailable"}                        Photoshop is not running
//   {"type":"error","message":"..."}
//
// Brush values are only reachable through Action Manager inside ExtendScript,
// and every DoJavaScript call costs about 200ms of fixed overhead whatever it
// contains (measured: 203ms for `"x";`, against 1.7ms for a direct COM
// property). So commands are answered one at a time and the caller coalesces —
// never queue these, or the panel would fall minutes behind a drag.
internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // Reads the current tool's brush. Photoshop exposes no direct COM property
    // for these, hence the Action Manager round trip.
    private const string ReadScript = """
        var r = new ActionReference();
        r.putProperty(stringIDToTypeID("property"), stringIDToTypeID("currentToolOptions"));
        r.putEnumerated(stringIDToTypeID("application"), stringIDToTypeID("ordinal"), stringIDToTypeID("targetEnum"));
        var o = executeActionGet(r).getObjectValue(stringIDToTypeID("currentToolOptions"));
        if (!o.hasKey(stringIDToTypeID("brush"))) { "none"; } else {
          var b = o.getObjectValue(stringIDToTypeID("brush"));
          "" + b.getUnitDoubleValue(stringIDToTypeID("diameter")) + "," + b.getUnitDoubleValue(stringIDToTypeID("angle"));
        }
        """;

    // Targets the brush class with an ordinal target, i.e. the selected brush.
    // A `set` aimed at currentToolOptions is refused ("command not available").
    //
    // Both diameter and angle are always written. Photoshop resets a brush
    // field this descriptor omits — writing angle alone drops the diameter to
    // its 25px default — so a partial set is refused rather than sent.
    private const string SetScriptTemplate = """
        var d = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Brsh"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        d.putReference(charIDToTypeID("null"), ref);
        var b = new ActionDescriptor();
        __FIELDS__
        d.putObject(charIDToTypeID("T   "), charIDToTypeID("Brsh"), b);
        executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
        "ok";
        """;

    private static object? photoshop;

    [STAThread]
    private static void Main()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            try
            {
                Handle(line);
            }
            catch (Exception ex)
            {
                // A COM failure usually means Photoshop is mid-modal or was
                // closed. Drop the connection so the next command reconnects.
                photoshop = null;
                Write(new { type = "error", message = Flatten(ex) });
            }
        }
    }

    private static void Handle(string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

        dynamic? app = Connect();
        if (app is null)
        {
            Write(new { type = "unavailable" });
            return;
        }

        switch (type)
        {
            case "read":
                WriteBrush(app);
                break;

            case "set":
                var hasDiameter = root.TryGetProperty("diameter", out var dia) && dia.ValueKind == JsonValueKind.Number;
                var hasAngle = root.TryGetProperty("angle", out var ang) && ang.ValueKind == JsonValueKind.Number;
                if (!hasDiameter || !hasAngle)
                {
                    Write(new { type = "error", message = "set needs both diameter and angle: a partial set resets the omitted field" });
                    return;
                }
                var wantDiameter = Math.Clamp(dia.GetDouble(), 1, 5000);
                // Photoshop takes brush angle as -180..180; the panel sends 0..359.
                var wantAngle = ((ang.GetDouble() % 360) + 360) % 360;
                if (wantAngle > 180) wantAngle -= 360;
                var fields = string.Join("\n", new[]
                {
                    $"b.putUnitDouble(charIDToTypeID(\"Dmtr\"), charIDToTypeID(\"#Pxl\"), {Num(wantDiameter)});",
                    $"b.putUnitDouble(charIDToTypeID(\"Angl\"), charIDToTypeID(\"#Ang\"), {Num(wantAngle)});"
                });
                app.DoJavaScript(SetScriptTemplate.Replace("__FIELDS__", fields));
                WriteBrush(app);
                break;

            case "action":
                var name = root.TryGetProperty("name", out var n) ? n.GetString() : null;
                var set = root.TryGetProperty("set", out var s) ? s.GetString() : null;
                if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(set))
                {
                    Write(new { type = "error", message = "action needs both set and name" });
                    return;
                }
                app.DoAction(name, set);
                Write(new { type = "actionDone", name });
                break;

            default:
                Write(new { type = "error", message = $"unknown command: {type}" });
                break;
        }
    }

    private static string Num(double v) =>
        v.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);

    private static void WriteBrush(dynamic app)
    {
        string result = app.DoJavaScript(ReadScript);
        if (result == "none")
        {
            // A non-brush tool is selected, so there is nothing to report.
            Write(new { type = "brush", available = false });
            return;
        }
        var parts = result.Split(',');
        if (parts.Length != 2
            || !double.TryParse(parts[0], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var diameter)
            || !double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var angle))
        {
            Write(new { type = "error", message = $"unparsable brush read: {result}" });
            return;
        }
        Write(new { type = "brush", diameter, angle });
    }

    /// Attaches to a running Photoshop, or returns null. Never starts it: the
    /// desk panel asking for a brush value must not launch a 2GB application.
    private static object? Connect()
    {
        if (Process.GetProcessesByName("Photoshop").Length == 0)
        {
            photoshop = null;
            return null;
        }
        if (photoshop is not null) return photoshop;
        var type = Type.GetTypeFromProgID("Photoshop.Application");
        if (type is null) return null;
        dynamic? app = Activator.CreateInstance(type);
        if (app is null) return null;
        // psDisplayNoDialogs. Without this, a failing call puts a modal error
        // box on Photoshop and blocks it until somebody clicks OK — a bad
        // Action name from the panel would freeze the application. With it, the
        // failure comes back here as a COM exception instead.
        app.DisplayDialogs = 3;
        photoshop = app;
        return photoshop;
    }

    private static string Flatten(Exception ex)
    {
        var message = ex.Message.Replace("\r", " ").Replace("\n", " ");
        if (ex is COMException com) message = $"0x{com.HResult:X8} {message}";
        return message.Length > 400 ? message[..400] : message;
    }

    private static void Write(object payload)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
        Console.Out.Flush();
    }
}
