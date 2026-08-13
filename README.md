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

## Dictation Mute

While the Handy dictation app is listening, the service mutes the Discord microphone and unmutes it
again when dictation stops or is cancelled. A mute you set yourself is left alone: the service reads
the mute state at dictation start and only restores what it changed.

Handy has no event API, so the service tails Handy's own log at
`%LOCALAPPDATA%\com.pais.handy\logs\handy.log`. The start marker exists only while Handy's log level
is `debug`, so leave that setting on.

Discord is controlled over its local RPC pipe, which needs a Discord application:

1. Create an app at <https://discord.com/developers/applications>. The owner is whitelisted for RPC
   automatically.
2. Add `http://localhost` as an OAuth2 redirect URI.
3. Put the client id and secret under `dictationMute.discord` in
   `%APPDATA%\RaphiiWinUtils\config.json`.
4. Open the dashboard, go to Audio, and press **Reauthorize Discord**. Accept the prompt Discord
   shows. The refresh token is stored in `%APPDATA%\RaphiiWinUtils\discord-tokens.json`.

Repeat step 4 whenever Discord drops the authorization. The Audio card also carries the on/off
toggle, which survives a service restart. `dictationMute.maxMuteMs` unmutes anyway when a stop event
never arrives.

Discord allows one RPC voice-settings controller at a time, so this can conflict with other tools
that set voice settings over RPC.

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

Use `install:local` for the first installation or deliberate temporary testing only. Normal deployment is:

1. Commit and push `main`.
2. Let the pre-push watcher request one update check.
3. Wait for `Update handoff complete` in `%APPDATA%\RaphiiWinUtils\logs\update-YYYY-MM-DD.log`.

Do not manually copy files or run `install:local` while that handoff is still running. The updater may spend
several minutes building before it stops the installed process, copies the build, writes the deployed revision,
and starts the replacement.

## Dashboard

Open <http://127.0.0.1:17642/> for the local dashboard — a dark "ambient ops" panel sized for both
desktop and VR overlay use (large touch targets throughout). It has three views:

- **Home** (default): clock, service status, and tool tiles.
- **Audio**: one-tap output routing between the configured audio modes (active mode highlighted),
  and per-channel volume with −/+ steppers and a full-width tap-or-drag level track.
- **Wallpapers**: the wallpaper manager below.

## Wallpaper Manager

Open <http://127.0.0.1:17642/#wallpapers> for the wallpaper view of the dashboard. It renders the real monitor layout (positions and
native resolutions straight from the shell's `IDesktopWallpaper`), lets you pick a library image per
monitor, crop it in that monitor's aspect ratio, and apply.

Applying pre-crops each image to its monitor's native resolution and sets it once through the
Windows API. Nothing renders or loops afterwards. Crops are content-addressed in a cache directory,
so re-applying the same preset reuses the existing files and is a no-op on disk.

Files live outside the repo:

```text
%APPDATA%\RaphiiWinUtils\wallpapers\library\    uploaded images
%APPDATA%\RaphiiWinUtils\wallpapers\cache\      cropped per-monitor output
%APPDATA%\RaphiiWinUtils\wallpapers\presets.json
%APPDATA%\RaphiiWinUtils\wallpapers\current.json
```

Every successful apply records what landed in `current.json`, and the dashboard opens on it — a refresh
shows the configuration that is actually on the desktop, crops included, without needing a saved
preset. Only monitors whose apply succeeded are recorded, and assignments whose monitor or image has
since disappeared are dropped on load rather than shown as set.

Windows-native work lives in the `WallpaperHelper` C# helper (`npm run build:helper:wallpaper`).
A preset stores monitor device paths; assignments for monitors that are not currently connected are
reported and skipped rather than failing the apply.

Each monitor is listed with its EDID name and connector (from `QueryDisplayConfig`), because several
identical panels legitimately report the same name. A daisy-chained monitor can show up as a second
fully active display with its own desktop area — Windows reports it as real, so it cannot be detected
and dropped. Use **Hide** on that row instead; the choice persists in
`%APPDATA%\RaphiiWinUtils\wallpapers\hidden-monitors.json` and hidden monitors are skipped on apply
even if an old preset still targets them.

## Local Control API

The app exposes a localhost-only Elysia API:

```text
GET  http://127.0.0.1:17642/               dashboard UI
GET  http://127.0.0.1:17642/health
POST http://127.0.0.1:17642/update/check
GET  http://127.0.0.1:17642/audio/modes
POST http://127.0.0.1:17642/audio/modes/:id
GET  http://127.0.0.1:17642/audio/volumes
POST http://127.0.0.1:17642/audio/volumes/:name
GET  http://127.0.0.1:17642/dictation-mute
POST http://127.0.0.1:17642/dictation-mute                      { "enabled": true }
POST http://127.0.0.1:17642/dictation-mute/authorize
GET  http://127.0.0.1:17642/api/wallpaper/monitors
PUT  http://127.0.0.1:17642/api/wallpaper/hidden
GET  http://127.0.0.1:17642/api/wallpaper/library
GET  http://127.0.0.1:17642/api/wallpaper/library/:file
POST http://127.0.0.1:17642/api/wallpaper/library?name=<file>   raw image bytes
GET  http://127.0.0.1:17642/api/wallpaper/current
GET  http://127.0.0.1:17642/api/wallpaper/presets
PUT  http://127.0.0.1:17642/api/wallpaper/presets/:name
POST http://127.0.0.1:17642/api/wallpaper/apply
```

The `POST /update/check` route queues one self-update check. If a check is already running it returns `409` and leaves the running check alone.
The `POST /dictation-mute/authorize` route makes Discord show a consent prompt, so it only succeeds while someone is at the machine.
The volume endpoint expects `{ "volumePercent": 0..100 }` and remains localhost-only.

## Home Assistant VR Recovery

When MQTT is enabled, the discovered **Shirakami** device exposes two mutually exclusive buttons:

- **Start VRChat** cleanly restarts the VR stack and launches VRChat normally.
- **SteamVR soft recovery** cleanly restarts VRChat, SteamVR, and OyasumiVR, then rejoins the latest
  VRChat instance found in `output_log_*.txt`.

Hard recovery is owned by Home Assistant and is deliberately requested over MQTT with an owner-created
operation ID; it records that instance, force-stops the VR stack, and requests `shutdown.exe /r /f /t 0`.
The forced reboot does not wait for Windows' application-close prompt.

All three routes go through one shared coordinator. A second request while any recovery is active is
rejected, and duplicate MQTT delivery cannot start a second recovery. SteamVR is launched through
Steam app `250820`, OyasumiVR through `2538150`, and VRChat through `438100`; launching through Steam
preserves any Steam launch options such as CPU affinity.

Hard recovery needs Windows autologin because Steam, SteamVR, and VRChat must run in the interactive
desktop session. After Windows logs in and RaphiiWinUtils reconnects to MQTT, Home Assistant resumes
the original operation. RaphiiWinUtils then waits for the desktop settling period, a verified
VBAN-TEXT reply from Matrix Coconut, Steam, SteamVR, OyasumiVR, and finally VRChat. Matrix and
desktop waits are configured under `hardRecovery`; VR-stack readiness and retry budgets are under
`vrStackStartup`.

The retained `raphiiwinutils/shirakami/vr/recovery/status` topic contains JSON with an operation ID,
phase, timestamps, attempt count, captured instance ID, and failure reason. It is also exposed as the
**VR recovery status** MQTT sensor. The local hard-recovery journal is stored at:

```text
%APPDATA%\RaphiiWinUtils\hard-recovery-status.json
```

The recovery owner must resume only the operation it observed by publishing this non-retained command
after RWU returns online:

```json
topic: raphiiwinutils/shirakami/vr/recovery/hard/resume/set
payload: { "operationId": "<status.operationId>" }
```

To begin a hard recovery, publish a non-retained JSON request. RWU persists and confirms this same
operation ID on the status topic before it asks Windows to reboot:

```json
topic: raphiiwinutils/shirakami/vr/recovery/hard/set
payload: { "operationId": "<new UUID generated and retained by Home Assistant>" }
```

If the owner observes that reboot never happened or the PC did not return by its deadline, it should
end the operation explicitly instead of leaving the coordinator locked:

```json
topic: raphiiwinutils/shirakami/vr/recovery/hard/cancel/set
payload: { "operationId": "<status.operationId>", "reason": "PC did not return after reboot" }
```

These control commands must never be retained. Terminal phases are `completed`,
`completed-with-warning`, and `failed-needs-attention`; no automatic second reboot is issued.

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

Its VR controls restart the VR stack, recover the most recently joined instance, or request the
durable hard-recovery workflow. Configure Steam app IDs and shutdown waits under
`vrChatRecovery`, shared VR-stack readiness and retry windows under `vrStackStartup`, and
post-reboot Matrix/desktop waits under `hardRecovery`.

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
