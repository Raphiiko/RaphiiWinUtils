# RaphiiWinUtils

Personal Windows glue service for local audio/control/clipboard workflows.

The first workflow mirrors Windows endpoint volume/mute state from renamed VBMatrix playback devices into VB-Audio Matrix Coconut preset patch gain/mute values.
Volume/mute changes are event-driven through the `AudioEndpointWatcher` helper; `audio.endpointResyncMs` controls only the slow fallback endpoint rediscovery snapshot.

The clipboard workflow listens for text clipboard changes and rewrites social links to embed-friendly alternate frontends:

- `x.com` / `twitter.com` status links -> `girlcockx.com`
- `tiktok.com` / `vm.tiktok.com` links -> `tnktok.com`
- `bsky.app` links -> `bskx.app`
- `reddit.com` links -> `rxddit.com`
- `instagram.com` post/reel/tv links -> `kkinstagram.com`
- `pixiv.net` artwork links -> `phixiv.net`

Runtime wiring is split by feature under `src/modules`, with feature-specific code under folders like `src/service`, `src/clipboard`, `src/audio`, and `src/matrix`.

No secrets or machine-specific runtime config are stored in this repo. On first run the service creates:

```text
%APPDATA%\RaphiiWinUtils\config.json
```

## Development

```powershell
bun install
bun run build:all
bun run dev
```

## Install Locally

```powershell
bun run install:local
```

The install command builds the app into:

```text
C:\Tools\RaphiiWinUtils
```

It also:

- creates a startup shortcut in the current user's Startup folder
- registers the Windows notification identity
- installs a local `pre-push` Git hook that starts a background watcher; Git has no native `post-push` hook, so the watcher waits for `git push` to exit before asking the running app to check for updates

## Local Control API

The app exposes a localhost-only Elysia API:

```text
GET  http://127.0.0.1:17642/health
POST http://127.0.0.1:17642/update/check
```

The `POST /update/check` route queues one self-update check. If a check is already running it returns `409` and leaves the running check alone.

## Matrix Requirements

In VB-Audio Matrix Coconut:

- Enable VBAN.
- Enable the incoming VBAN-TEXT stream named `Command1`.
- Keep Matrix running while this service runs.

The default mapping expects these Windows playback endpoint names:

```text
System Audio
Browser Audio
Voice Audio
Music Audio
Game Audio
```

Each endpoint maps to `PresetPatch[1]` through `PresetPatch[5]`.
