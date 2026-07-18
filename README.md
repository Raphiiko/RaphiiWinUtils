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

## Home Assistant Audio Control

Home Assistant can be the durable control plane for audio modes and the System, Browser, Voice,
Game, and Music volumes. This works even when the PC or this app is unavailable: Home Assistant
keeps requested values in helpers, and RaphiiWinUtils reconciles them as soon as both are back. The
service only reports an audio mode as current after Matrix output, volume policies, and microphone
routing have all verified successfully.

1. Add [raphii-win-utils-helpers.yaml](home-assistant/raphii-win-utils-helpers.yaml) to Home
   Assistant (or copy its helpers to the UI). Update the `input_select` options if you change
   `audioModes.modes`. Leave the `input_boolean.raphiiwinutils_volumes_initialized` helper off on
   first install: the app will seed the volume helpers from the PC once all endpoints are available,
   rather than applying Home Assistant's default `0` values to Windows.
2. Create a Home Assistant long-lived access token and configure the generated
   `%APPDATA%\RaphiiWinUtils\config.json`. Do not commit that token.

```json
{
  "homeAssistant": {
    "enabled": true,
    "url": "http://homeassistant.local:8123",
    "accessToken": "your-long-lived-token",
    "audioModeEntityId": "input_select.raphii_audio_mode",
    "currentAudioModeEntityId": "input_text.raphii_audio_mode_current",
    "volumeInitializationEntityId": "input_boolean.raphiiwinutils_volumes_initialized",
    "volumeEntityIds": {
      "System": "input_number.raphii_system_volume",
      "Browser": "input_number.raphii_browser_volume",
      "Voice": "input_number.raphii_voice_volume",
      "Music": "input_number.raphii_music_volume",
      "Game": "input_number.raphii_game_volume"
    },
    "syncIntervalMs": 5000,
    "requestTimeoutMs": 3000
  }
}
```

The app calls Home Assistant rather than exposing its control API to the network. A dashboard change
therefore survives PC and app restarts; temporary Home Assistant/network errors are logged and retried
on the next sync. Local Stream Deck mode changes and local volume changes are also written back to
the helpers. Local changes made while HA is unreachable are stored in a small on-PC outbox and are
written to HA before it accepts older dashboard values after recovery. `sensor.raphii_win_utils` is
refreshed while the app is connected and includes available modes plus live channel diagnostics.

To add the PC tab to the existing Debug dashboard, append
[raphii-win-utils-debug-view.yaml](home-assistant/raphii-win-utils-debug-view.yaml) as one item under
that dashboard's `views:` list. It displays the requested and last-confirmed modes, all five volume
controls, and the service's last update. The sensor becomes stale when the PC is off, which helps
distinguish the persisted requested state from a confirmed current state.

`audioModeWebhookUrl` remains available for existing automations. It is now sent only after the local
audio mode has succeeded, so downstream device behavior cannot be triggered by a failed switch.

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
