import { Buffer } from "node:buffer";
import type { Logger } from "../system/logger.ts";
import type { AudioEndpointWatcher } from "./audioEndpointWatcher.ts";
import { getHelperPath } from "../system/paths.ts";
import { requireSuccess } from "../system/process.ts";

export interface AudioEndpointVolumePolicy {
  endpointNameContains: string;
  volumePercent: number;
  mode: "cap" | "set";
}

export interface AudioEndpointVolumePolicyResult {
  endpointNameContains: string;
  endpointName?: string;
  targetVolumePercent: number;
  mode: "cap" | "set";
  found: boolean;
  changed: boolean;
  previousVolumePercent?: number;
  muted?: boolean;
}

export interface AudioEndpointVolumeController {
  apply(policies: AudioEndpointVolumePolicy[]): Promise<void>;
}

interface VolumePolicyResponse {
  type: "volume-policy-result";
  results: AudioEndpointVolumePolicyResult[];
}

export class WindowsAudioEndpointVolumeController implements AudioEndpointVolumeController {
  private readonly log: Logger;

  constructor(logger: Logger) {
    this.log = logger.child("endpoint-volume");
  }

  async apply(policies: AudioEndpointVolumePolicy[]): Promise<void> {
    if (policies.length === 0) return;

    const payload = Buffer.from(JSON.stringify(policies), "utf8").toString("base64");
    const result = await requireSuccess(
      getHelperPath(),
      [`--apply-volume-policies-base64=${payload}`],
      { timeoutMs: 10_000 }
    );
    const response = parseResponse(result.stdout);
    const missing = response.results.filter((entry) => !entry.found);
    if (missing.length > 0) {
      throw new Error(
        `Audio endpoints not found: ${missing
          .map((entry) => entry.endpointNameContains)
          .join(", ")}`
      );
    }

    for (const entry of response.results) {
      this.log.info(entry.changed ? "Audio endpoint volume changed" : "Audio endpoint unchanged", {
        name: entry.endpointName,
        mode: entry.mode,
        previousVolumePercent: entry.previousVolumePercent,
        targetVolumePercent: entry.targetVolumePercent,
        muted: entry.muted
      });
    }
  }
}

export class WatchedAudioEndpointVolumeController implements AudioEndpointVolumeController {
  private readonly watcher: AudioEndpointWatcher;

  constructor(watcher: AudioEndpointWatcher) {
    this.watcher = watcher;
  }

  async apply(policies: AudioEndpointVolumePolicy[]): Promise<void> {
    for (const policy of policies) {
      if (policy.mode !== "set") {
        throw new Error("The persistent audio watcher only supports set volume policies");
      }

      const results = await this.watcher.setVolume(
        policy.endpointNameContains,
        policy.volumePercent
      );
      const missing = results.filter((entry) => !entry.found);
      if (missing.length > 0) {
        throw new Error(
          `Audio endpoints not found: ${missing
            .map((entry) => entry.endpointNameContains)
            .join(", ")}`
        );
      }
    }
  }
}

function parseResponse(stdout: string): VolumePolicyResponse {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .findLast(Boolean);
  if (!line) throw new Error("Audio endpoint volume helper returned no response");

  const response = JSON.parse(line) as Partial<VolumePolicyResponse>;
  if (response.type !== "volume-policy-result" || !Array.isArray(response.results)) {
    throw new Error(`Invalid audio endpoint volume helper response: ${line}`);
  }

  return response as VolumePolicyResponse;
}
