# RaphiiWinUtils

Personal Windows glue service for local audio/control workflows.

The first workflow mirrors Windows endpoint volume/mute state from renamed VBMatrix playback devices into VB-Audio Matrix Coconut preset patch gain/mute values.

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

and creates a startup shortcut in the current user's Startup folder.

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
