import type { AudioModeSummary } from "../service/audioModeService.ts";

export interface AudioModePublisher {
  /** Applying a mode also switches to its mic, so this publishes both. */
  publishMode(mode: AudioModeSummary, availableModes: AudioModeSummary[]): Promise<void>;
  publishMic(micId: string): Promise<void>;
}
