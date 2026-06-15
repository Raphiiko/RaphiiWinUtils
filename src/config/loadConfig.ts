import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfig, type AppConfig } from "./schema";

export function getConfigPath(): string {
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
  return join(appData, "RaphiiWinUtils", "config.json");
}

export async function loadConfig(): Promise<AppConfig> {
  const path = getConfigPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(defaultConfig, null, 2)}\n`);
    return structuredClone(defaultConfig);
  }

  const userConfig = JSON.parse(await Bun.file(path).text()) as Partial<AppConfig>;
  return mergeConfig(defaultConfig, userConfig);
}

function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
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
        ...override.audioModes?.modes
      }
    },
    updater: { ...base.updater, ...override.updater },
    control: { ...base.control, ...override.control },
    notifications: { ...base.notifications, ...override.notifications }
  };
}
