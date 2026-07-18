import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigPath } from "../config/loadConfig.ts";

export interface AudioMqttState {
  mode?: string;
  channelVolumes: Record<string, number>;
}

export interface AudioMqttStateStore {
  load(): Promise<AudioMqttState>;
  save(state: AudioMqttState): Promise<void>;
}

export class FileAudioMqttStateStore implements AudioMqttStateStore {
  private readonly path = join(dirname(getConfigPath()), "mqtt-audio-state.json");

  async load(): Promise<AudioMqttState> {
    if (!existsSync(this.path)) return { channelVolumes: {} };
    const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<AudioMqttState>;
    return {
      mode: typeof value.mode === "string" ? value.mode : undefined,
      channelVolumes: value.channelVolumes ?? {}
    };
  }

  async save(state: AudioMqttState): Promise<void> {
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}
