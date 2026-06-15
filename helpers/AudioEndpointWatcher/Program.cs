using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using NAudio.CoreAudioApi;

var pollMs = ParsePollMs(args);
using var watcher = new EndpointWatcher(pollMs);
watcher.Run();

static int ParsePollMs(string[] args)
{
    foreach (var arg in args)
    {
        if (!arg.StartsWith("--poll-ms=", StringComparison.OrdinalIgnoreCase)) continue;
        if (int.TryParse(arg["--poll-ms=".Length..], out var value)) return Math.Max(250, value);
    }

    return 1000;
}

internal sealed class EndpointWatcher : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly int pollMs;
    private readonly MMDeviceEnumerator enumerator = new();
    private readonly ConcurrentDictionary<string, EndpointSubscription> subscriptions = new();
    private readonly Timer pollTimer;
    private readonly object writeLock = new();

    public EndpointWatcher(int pollMs)
    {
        this.pollMs = pollMs;
        pollTimer = new Timer(_ => SafeSnapshot("poll"), null, Timeout.Infinite, Timeout.Infinite);
    }

    public void Run()
    {
        SubscribeAll();
        Write(new { type = "ready" });
        SafeSnapshot("snapshot");
        pollTimer.Change(pollMs, pollMs);
        Thread.Sleep(Timeout.Infinite);
    }

    public void Dispose()
    {
        pollTimer.Dispose();
        foreach (var subscription in subscriptions.Values) subscription.Dispose();
        subscriptions.Clear();
        enumerator.Dispose();
    }

    private void SubscribeAll()
    {
        foreach (var device in EnumerateRenderDevices())
        {
            if (subscriptions.ContainsKey(device.ID))
            {
                device.Dispose();
                continue;
            }

            var callback = new AudioEndpointVolumeNotificationDelegate(data =>
            {
                var endpoint = EndpointState.FromDevice(device, "event");
                Write(new { type = "endpoint", endpoint });
            });

            device.AudioEndpointVolume.OnVolumeNotification += callback;
            subscriptions[device.ID] = new EndpointSubscription(device, callback);
        }
    }

    private void SafeSnapshot(string source)
    {
        try
        {
            SubscribeAll();
            var endpoints = EnumerateRenderDevices()
                .Select(device =>
                {
                    using (device) return EndpointState.FromDevice(device, source);
                })
                .OrderBy(endpoint => endpoint.Name, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            Write(new { type = "snapshot", endpoints });
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
        }
    }

    private IEnumerable<MMDevice> EnumerateRenderDevices()
    {
        return enumerator
            .EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .ToArray();
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

internal sealed class EndpointSubscription : IDisposable
{
    private readonly MMDevice device;
    private readonly AudioEndpointVolumeNotificationDelegate callback;

    public EndpointSubscription(MMDevice device, AudioEndpointVolumeNotificationDelegate callback)
    {
        this.device = device;
        this.callback = callback;
    }

    public void Dispose()
    {
        try
        {
            device.AudioEndpointVolume.OnVolumeNotification -= callback;
        }
        finally
        {
            device.Dispose();
        }
    }
}

internal sealed record EndpointState(
    string Id,
    string Name,
    string DataFlow,
    float VolumeScalar,
    int VolumePercent,
    bool Muted,
    string Source)
{
    public static EndpointState FromDevice(MMDevice device, string source)
    {
        var scalar = device.AudioEndpointVolume.MasterVolumeLevelScalar;
        return new EndpointState(
            device.ID,
            device.FriendlyName,
            device.DataFlow.ToString(),
            scalar,
            (int)Math.Round(scalar * 100),
            device.AudioEndpointVolume.Mute,
            source);
    }
}
