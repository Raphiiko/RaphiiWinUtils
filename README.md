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
```

The `POST /update/check` route queues one self-update check. If a check is already running it returns `409` and leaves the running check alone.

## Home Assistant Audio Mode Sync

When an audio mode is requested, the app immediately publishes it to a Home Assistant webhook while
the local Matrix output and microphone routing changes continue. Home Assistant remains responsible
for device-specific behavior such as selecting the KEF optical input.

Configure the generated webhook URL in `%APPDATA%\RaphiiWinUtils\config.json`:

```json
{
  "homeAssistant": {
    "enabled": true,
    "audioModeWebhookUrl": "http://homeassistant.local:8123/api/webhook/replace-with-webhook-id",
    "requestTimeoutMs": 3000
  }
}
```

Webhook failures are logged but do not make the local audio mode operation fail. Because publishing
happens first, Home Assistant represents the requested mode even if the later local Matrix operation
fails.

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
