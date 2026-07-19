import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { migrateAudioModeOverrides } from "./audioModeIds.ts";
import { defaultConfig, type AppConfig, type VrStackStartupConfig } from "./schema.ts";

export function getConfigPath(): string {
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
  return join(appData, "RaphiiWinUtils", "config.json");
}

export async function loadConfig(): Promise<AppConfig> {
  const path = getConfigPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
    return structuredClone(defaultConfig);
  }

  const userConfig = JSON.parse(await readFile(path, "utf8")) as Partial<AppConfig>;
  return mergeConfig(defaultConfig, userConfig);
}

function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  const modeOverrides = migrateAudioModeOverrides(override.audioModes?.modes);
  // Startup readiness settings used to live under hardRecovery. Preserve local overrides while
  // letting the dedicated shared setting take precedence.
  const legacyVrStackStartup = override.hardRecovery as Partial<VrStackStartupConfig> | undefined;
  return {
    matrix: { ...base.matrix, ...override.matrix },
    audio: {
      ...base.audio,
      ...override.audio,
      channels: override.audio?.channels ?? base.audio.channels
    },
    audioModes: {
      ...base.audioModes,
      ...override.audioModes,
      modes: {
        ...base.audioModes.modes,
        ...modeOverrides
      }
    },
    mqtt: { ...base.mqtt, ...override.mqtt },
    clipboard: { ...base.clipboard, ...override.clipboard },
    xsOverlayRecovery: { ...base.xsOverlayRecovery, ...override.xsOverlayRecovery },
    vrChatRecovery: { ...base.vrChatRecovery, ...override.vrChatRecovery },
    vrStackStartup: {
      ...base.vrStackStartup,
      ...legacyVrStackStartup,
      ...override.vrStackStartup
    },
    hardRecovery: { ...base.hardRecovery, ...override.hardRecovery },
    updater: { ...base.updater, ...override.updater },
    control: { ...base.control, ...override.control },
    notifications: { ...base.notifications, ...override.notifications }
  };
}
