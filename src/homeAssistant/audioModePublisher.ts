import type { AudioModeSummary } from "../service/audioModeService.ts";

export interface AudioModePublisher {
  publishMode(mode: AudioModeSummary, availableModes: AudioModeSummary[]): Promise<void>;
}
