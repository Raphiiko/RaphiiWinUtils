# RaphiiWinUtils

Personal Windows glue service for local audio/control/clipboard workflows.

The first workflow mirrors Windows endpoint volume/mute state from renamed VBMatrix playback devices into VB-Audio Matrix Coconut preset patch gain/mute values.
Volume/mute changes are event-driven through the `AudioEndpointWatcher` helper; `audio.endpointResyncMs` controls only the slow fallback endpoint rediscovery snapshot.

The clipboard workflow listens for text clipboard changes and rewrites social links to embed-friendly alternate frontends:

- `x.com` / `twitter.com` status links -> `fixvx.com`
- `tiktok.com` / `vm.tiktok.com` links -> `tnktok.com`
- `bsky.app` links -> `bskx.app`
- `reddit.com` links -> `rxddit.com`
- `instagram.com` post/reel/tv links -> `kkinstagram.com`
- `pixiv.net` artwork links -> `phixiv.net`

## XSOverlay Crash Recovery

When SteamVR's `vrmonitor.exe` is running, the service watches for the primary `XSOverlay.exe`
process. Recovery is armed only after XSOverlay has been observed running in the current SteamVR
session. If it later disappears, the service confirms the absence and asks Steam to relaunch app
`1173510`. It never launches XSOverlay after SteamVR has stopped or if XSOverlay was already absent
when the service began observing the session.

The default retry budget is five Steam launch attempts, with a 20-second launch grace period and
increasing retry delays. A successful run must remain alive for 60 seconds before the retry budget
is reset. Configure this under `xsOverlayRecovery` in `%APPDATA%\RaphiiWinUtils\config.json`.
If Steam is installed somewhere other than the default location, set `xsOverlayRecovery.steamPath`
to its `steam.exe` path.

Runtime wiring is split by feature under `src/modules`, with feature-specific code under folders like `src/service`, `src/clipboard`, `src/audio`, and `src/matrix`.

No secrets or machine-specific runtime config are stored in this repo. On first run the service creates:

```text
%APPDATA%\RaphiiWinUtils\config.json
```

## Development

```powershell
fnm use
npm install
npm run build:all
npm run dev
```

## Install Locally

```powershell
npm run install:local
```

The install command builds the app into:

```text
C:\Tools\RaphiiWinUtils
```

It also:

- registers a hidden logon scheduled task that launches the app with Node 26
- registers the Windows notification identity
- installs a local `pre-push` Git hook that starts a background watcher; Git has no native `post-push` hook, so the watcher waits for `git push` to exit before asking the running app to check for updates

## Local Control API

The app exposes a localhost-only Elysia API:

```text
GET  http://127.0.0.1:17642/health
POST http://127.0.0.1:17642/update/check
GET  http://127.0.0.1:17642/audio/modes
POST http://127.0.0.1:17642/audio/modes/:id
GET  http://127.0.0.1:17642/audio/volumes
POST http://127.0.0.1:17642/audio/volumes/:name
```

The `POST /update/check` route queues one self-update check. If a check is already running it returns `409` and leaves the running check alone.
The volume endpoint expects `{ "volumePercent": 0..100 }` and remains localhost-only.

## Home Assistant VRChat Recovery

When MQTT is enabled, the discovered **Shirakami** device also exposes two buttons:

- **Recover VRChat** stops a running `VRChat.exe`, remembers the last instance from VRChat's newest
  `output_log_*.txt`, restarts SteamVR, and relaunches VRChat into that instance when one was found.
- **Start VRChat** performs the same clean restart but launches into the normal VRChat home world.

The actions are process-wide serialized: a second button press while either action is running is
ignored. SteamVR is launched through Steam app `250820`, and VRChat through app `438100`; VRChat is
started without `--no-vr`, so it uses the active SteamVR runtime. Configure timings or a non-default
Steam location under `vrChatRecovery` in `%APPDATA%\RaphiiWinUtils\config.json`.
Because VRChat is launched through Steam rather than directly through `VRChat.exe`, any VRChat launch
options configured in Steam (such as CPU-affinity settings) continue to apply.

## Home Assistant Audio Control

Home Assistant can be the durable control plane for audio modes and the System, Browser, Voice,
Game, and Music volumes. This works even when the PC or this app is unavailable: Home Assistant
uses MQTT discovery. Home Assistant receives native controls without a long-lived Home Assistant
token, while the PC remains the authority for its actual Windows audio state. The service only
reports an audio mode as current after Matrix output, volume policies, and microphone routing have
all verified successfully.

1. Create a dedicated Mosquitto username/password for this PC.
2. Configure the generated `%APPDATA%\RaphiiWinUtils\config.json`. Do not commit the password.

```json
{
  "mqtt": {
    "enabled": true,
    "host": "homeassistant.local",
    "port": 1883,
    "username": "shirakami",
    "password": "your-broker-password",
    "clientId": "raphii-win-utils-shirakami",
    "baseTopic": "raphiiwinutils/shirakami",
    "discoveryPrefix": "homeassistant",
    "reconnectDelayMs": 5000
  }
}
```

The app does not expose its control API to the network. MQTT command topics are retained by Home
Assistant, while confirmed mode and volume states are retained by the broker and also saved locally
on the PC. The client reconnects automatically after either side restarts, republishes discovery and
the latest known state, and reapplies a retained command when it reconnects. Local Stream Deck changes
and direct Windows virtual-device volume changes are published back to the same Home Assistant controls.

The MQTT-discovered **Shirakami** device contains the audio-mode select, five volume sliders, and
availability status. Add those entities to any dashboard; no YAML helpers or REST token are needed.

Its VRChat controls restart SteamVR and launch VRChat (or recover the most recently joined instance).
They also launch OyasumiVR through Steam app `2538150` unless its `OyasumiVR.exe` process is already
running. Configure the Steam app IDs and launch delays under `vrChatRecovery`.

## Audio Mode Volume Policies

Before switching the Matrix output, every configured Windows audio channel is capped at
`audioModes.defaultChannelVolumeCapPercent`. Endpoints already below the cap are left unchanged, and
endpoint mute state is never modified.

Modes can define `channelVolumeOverrides` by audio channel name. Overrides run only after the output
switch is verified. The default `beyond` mode sets `Game` to 100% after selecting the Bigscreen
Beyond output.

## Matrix Requirements

In VB-Audio Matrix Coconut:

- Enable VBAN.
- Enable the incoming VBAN-TEXT stream named `Command1`.
- Keep Matrix running while this service runs.

Audio mode output changes are verified against the selected Matrix slot. If Matrix has not yet
discovered a newly connected Windows output, the service restarts the Matrix audio engine and retries
the assignment. `audioModes.outputRetryCount` limits the total assignment attempts.

The default mapping expects these Windows playback endpoint names:

```text
System Audio
Browser Audio
Voice Audio
Music Audio
Game Audio
```

Each endpoint maps to `PresetPatch[1]` through `PresetPatch[5]`.
