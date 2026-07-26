using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

if (TryParseVolumePolicies(args, out var volumePolicies))
{
    ApplyVolumePolicies(volumePolicies);
    return;
}

var resyncMs = ParseResyncMs(args);
try
{
    using var watcher = new EndpointWatcher(resyncMs);
    watcher.Run();
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex);
    Environment.ExitCode = 1;
}

static bool TryParseVolumePolicies(string[] args, out VolumePolicy[] policies)
{
    const string prefix = "--apply-volume-policies-base64=";
    var argument = args.FirstOrDefault(arg =>
        arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    if (argument is null)
    {
        policies = [];
        return false;
    }

    var json = Encoding.UTF8.GetString(Convert.FromBase64String(argument[prefix.Length..]));
    policies = JsonSerializer.Deserialize<VolumePolicy[]>(json, new JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true
    }) ?? [];
    return true;
}

static void ApplyVolumePolicies(IReadOnlyCollection<VolumePolicy> policies)
{
    using var enumerator = new MMDeviceEnumerator();
    var devices = enumerator
        .EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
        .ToArray();
    var results = new List<VolumePolicyResult>();

    foreach (var policy in policies)
    {
        var matches = devices
            .Where(device => device.FriendlyName.Contains(
                policy.EndpointNameContains,
                StringComparison.OrdinalIgnoreCase))
            .ToArray();

        if (matches.Length == 0)
        {
            results.Add(new VolumePolicyResult(
                policy.EndpointNameContains,
                null,
                policy.VolumePercent,
                policy.Mode,
                false,
                false,
                null,
                null));
            continue;
        }

        foreach (var device in matches)
        {
            var previousScalar = device.AudioEndpointVolume.MasterVolumeLevelScalar;
            var previousPercent = (int)Math.Round(previousScalar * 100);
            var targetPercent = Math.Clamp(policy.VolumePercent, 0, 100);
            var targetScalar = targetPercent / 100f;
            var shouldChange = policy.Mode switch
            {
                "cap" => previousScalar > targetScalar + 0.0001f,
                "set" => Math.Abs(previousScalar - targetScalar) > 0.0001f,
                _ => throw new ArgumentException($"Unknown volume policy mode: {policy.Mode}")
            };

            if (shouldChange)
            {
                device.AudioEndpointVolume.MasterVolumeLevelScalar = targetScalar;
            }

            results.Add(new VolumePolicyResult(
                policy.EndpointNameContains,
                device.FriendlyName,
                targetPercent,
                policy.Mode,
                true,
                shouldChange,
                previousPercent,
                device.AudioEndpointVolume.Mute));
        }
    }

    Console.WriteLine(JsonSerializer.Serialize(
        new { type = "volume-policy-result", results },
        new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
    foreach (var device in devices) device.Dispose();
}

static int ParseResyncMs(string[] args)
{
    foreach (var arg in args)
    {
        if (arg.StartsWith("--resync-ms=", StringComparison.OrdinalIgnoreCase) &&
            int.TryParse(arg["--resync-ms=".Length..], out var resyncMs))
        {
            return Math.Max(5000, resyncMs);
        }

        if (arg.StartsWith("--poll-ms=", StringComparison.OrdinalIgnoreCase) &&
            int.TryParse(arg["--poll-ms=".Length..], out var legacyPollMs))
        {
            return Math.Max(5000, legacyPollMs);
        }
    }

    return 60000;
}

internal sealed class EndpointWatcher : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private const int DeviceChangeDebounceMs = 500;

    private readonly int resyncMs;
    private readonly MMDeviceEnumerator enumerator = new();
    private readonly ConcurrentDictionary<string, EndpointSubscription> subscriptions = new();
    private readonly EndpointNotificationClient notificationClient;
    private readonly Timer resyncTimer;
    private readonly Timer deviceChangeTimer;
    private readonly object writeLock = new();
    private readonly object snapshotLock = new();
    private readonly ManualResetEventSlim stopEvent = new(false);
    private bool disposed;

    public EndpointWatcher(int resyncMs)
    {
        this.resyncMs = resyncMs;
        notificationClient = new EndpointNotificationClient(QueueDeviceSnapshot);
        resyncTimer = new Timer(_ => SafeSnapshot("resync"), null, Timeout.Infinite, Timeout.Infinite);
        deviceChangeTimer = new Timer(_ => SafeSnapshot("device-event"), null, Timeout.Infinite, Timeout.Infinite);
    }

    public void Run()
    {
        enumerator.RegisterEndpointNotificationCallback(notificationClient);
        _ = Task.Run(ReadCommands);
        Write(new { type = "ready" });
        SafeSnapshot("snapshot");
        resyncTimer.Change(resyncMs, resyncMs);
        stopEvent.Wait();
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;

        stopEvent.Set();
        resyncTimer.Dispose();
        deviceChangeTimer.Dispose();
        try
        {
            enumerator.UnregisterEndpointNotificationCallback(notificationClient);
        }
        catch
        {
            // Best-effort cleanup while the process is exiting.
        }

        foreach (var subscription in subscriptions.Values) subscription.Dispose();
        subscriptions.Clear();
        stopEvent.Dispose();
        enumerator.Dispose();
    }

    private void QueueDeviceSnapshot()
    {
        if (disposed) return;
        deviceChangeTimer.Change(DeviceChangeDebounceMs, Timeout.Infinite);
    }

    private void ReadCommands()
    {
        using var enumerator = new MMDeviceEnumerator();
        var devicesByFilter = new Dictionary<string, MMDevice[]>(StringComparer.OrdinalIgnoreCase);
        try
        {
            try
            {
                foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
                    devicesByFilter[device.ID] = [device];
            }
            catch (Exception ex)
            {
                Write(new { type = "error", message = $"Could not prewarm volume controls: {ex}" });
            }

            string? line;
            while (!disposed && (line = Console.ReadLine()) is not null)
            {
                string? requestId = null;
                string? deviceKey = null;
                try
                {
                    var command = JsonSerializer.Deserialize<VolumePolicyCommand>(line, new JsonSerializerOptions
                    {
                        PropertyNameCaseInsensitive = true
                    }) ?? throw new ArgumentException("Invalid audio endpoint command");
                    requestId = command.RequestId;
                    if (command.Type != "apply-volume-policy" || string.IsNullOrWhiteSpace(command.RequestId))
                        throw new ArgumentException("Unknown audio endpoint command");
                    if (command.Mode != "set") throw new ArgumentException("Unsupported audio endpoint volume mode");

                    deviceKey = command.EndpointId ?? $"name:{command.EndpointNameContains}";
                    if (!devicesByFilter.TryGetValue(deviceKey, out var devices))
                    {
                        devices = FindRenderDevices(
                            enumerator,
                            command.EndpointNameContains,
                            command.EndpointId);
                        if (devices.Length > 0) devicesByFilter[deviceKey] = devices;
                    }
                    ApplyVolumePolicy(command, devices);
                }
                catch (Exception ex)
                {
                    if (deviceKey is not null && devicesByFilter.Remove(deviceKey, out var staleDevices))
                        foreach (var device in staleDevices)
                            device.Dispose();
                    Write(new { type = "volume-policy-result", requestId, error = ex.Message, results = Array.Empty<VolumePolicyResult>() });
                }
            }
        }
        finally
        {
            foreach (var devices in devicesByFilter.Values)
                foreach (var device in devices)
                    device.Dispose();
        }
    }

    private static MMDevice[] FindRenderDevices(
        MMDeviceEnumerator enumerator,
        string nameContains,
        string? endpointId)
    {
        if (!string.IsNullOrWhiteSpace(endpointId)) return [enumerator.GetDevice(endpointId)];

        var devices = enumerator
            .EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .ToArray();
        var matches = devices
            .Where(device => device.FriendlyName.Contains(nameContains, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        var matchIds = matches.Select(device => device.ID).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var device in devices)
        {
            if (!matchIds.Contains(device.ID)) device.Dispose();
        }
        return matches;
    }

    private void ApplyVolumePolicy(VolumePolicyCommand command, MMDevice[] devices)
    {
        var targetPercent = Math.Clamp(command.VolumePercent, 0, 100);
        var targetScalar = targetPercent / 100f;
        var results = devices.Length == 0
            ? [new VolumePolicyResult(
                command.EndpointNameContains,
                null,
                targetPercent,
                command.Mode,
                false,
                false,
                null,
                null)]
            : devices.Select(device =>
            {
                device.AudioEndpointVolume.MasterVolumeLevelScalar = targetScalar;
                return new VolumePolicyResult(
                    command.EndpointNameContains,
                    null,
                    targetPercent,
                    command.Mode,
                    true,
                    true,
                    null,
                    null);
            }).ToArray();
        Write(new { type = "volume-policy-result", command.RequestId, results });
    }

    private void SubscribeAll(IReadOnlyCollection<MMDevice> activeDevices)
    {
        var activeIds = activeDevices.Select(device => device.ID).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var id in subscriptions.Keys)
        {
            if (activeIds.Contains(id)) continue;
            if (subscriptions.TryRemove(id, out var oldSubscription)) oldSubscription.Dispose();
        }

        foreach (var device in activeDevices)
        {
            if (subscriptions.ContainsKey(device.ID))
                continue;

            var subscriptionDevice = enumerator.GetDevice(device.ID);
            var callback = new AudioEndpointVolumeNotificationDelegate(data =>
            {
                try
                {
                    var endpoint = EndpointState.FromNotification(subscriptionDevice, data, "event");
                    Write(new { type = "endpoint", endpoint });
                }
                catch (Exception ex)
                {
                    Write(new { type = "error", message = ex.ToString() });
                }
            });

            subscriptionDevice.AudioEndpointVolume.OnVolumeNotification += callback;
            subscriptions[device.ID] = new EndpointSubscription(subscriptionDevice, callback);
        }
    }

    private void SafeSubscribeAll(IReadOnlyCollection<MMDevice> activeDevices)
    {
        try
        {
            SubscribeAll(activeDevices);
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
        }
    }

    private void SafeSnapshot(string source)
    {
        if (disposed) return;

        try
        {
            EndpointState[] endpoints;
            lock (snapshotLock)
            {
                if (disposed) return;
                var devices = EnumerateRenderDevices();
                SafeSubscribeAll(devices);
                endpoints = devices
                    .Select(device =>
                    {
                        using (device) return EndpointState.FromDevice(device, source);
                    })
                    .OrderBy(endpoint => endpoint.Name, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
            }

            Write(new { type = "snapshot", endpoints });
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = ex.ToString() });
        }
    }

    private MMDevice[] EnumerateRenderDevices()
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

internal sealed class EndpointNotificationClient : IMMNotificationClient
{
    private readonly Action onDeviceChanged;

    public EndpointNotificationClient(Action onDeviceChanged)
    {
        this.onDeviceChanged = onDeviceChanged;
    }

    public void OnDeviceStateChanged(string deviceId, DeviceState newState)
    {
        onDeviceChanged();
    }

    public void OnDeviceAdded(string pwstrDeviceId)
    {
        onDeviceChanged();
    }

    public void OnDeviceRemoved(string deviceId)
    {
        onDeviceChanged();
    }

    public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
    {
        if (flow == DataFlow.Render || flow == DataFlow.All) onDeviceChanged();
    }

    public void OnPropertyValueChanged(string pwstrDeviceId, PropertyKey key)
    {
        onDeviceChanged();
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

    public static EndpointState FromNotification(MMDevice device, AudioVolumeNotificationData data, string source)
    {
        var scalar = data.MasterVolume;
        return new EndpointState(
            device.ID,
            device.FriendlyName,
            device.DataFlow.ToString(),
            scalar,
            (int)Math.Round(scalar * 100),
            data.Muted,
            source);
    }
}

internal sealed record VolumePolicy(
    string EndpointNameContains,
    int VolumePercent,
    string Mode);

internal sealed record VolumePolicyResult(
    string EndpointNameContains,
    string? EndpointName,
    int TargetVolumePercent,
    string Mode,
    bool Found,
    bool Changed,
    int? PreviousVolumePercent,
    bool? Muted);

internal sealed record VolumePolicyCommand(
    string Type,
    string RequestId,
    string EndpointNameContains,
    string? EndpointId,
    int VolumePercent,
    string Mode);
