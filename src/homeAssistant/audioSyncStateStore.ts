import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigPath } from "../config/loadConfig.ts";

export interface AudioSyncOutbox {
  pendingMode?: string;
  pendingVolumes: Record<string, number>;
}

export interface AudioSyncStateStore {
  load(): Promise<AudioSyncOutbox>;
  save(state: AudioSyncOutbox): Promise<void>;
}

export class FileAudioSyncStateStore implements AudioSyncStateStore {
  private readonly path = join(dirname(getConfigPath()), "home-assistant-audio-outbox.json");

  async load(): Promise<AudioSyncOutbox> {
    if (!existsSync(this.path)) return { pendingVolumes: {} };
    const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<AudioSyncOutbox>;
    return {
      pendingMode: typeof value.pendingMode === "string" ? value.pendingMode : undefined,
      pendingVolumes: value.pendingVolumes ?? {}
    };
  }

  async save(state: AudioSyncOutbox): Promise<void> {
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}
