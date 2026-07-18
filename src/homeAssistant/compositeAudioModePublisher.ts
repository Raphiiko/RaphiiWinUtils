import type { AudioModePublisher } from "./audioModePublisher.ts";
import type { AudioModeSummary } from "../service/audioModeService.ts";

export class CompositeAudioModePublisher implements AudioModePublisher {
  private readonly publishers: AudioModePublisher[];

  constructor(publishers: AudioModePublisher[]) {
    this.publishers = publishers;
  }

  async publishMode(mode: AudioModeSummary, availableModes: AudioModeSummary[]): Promise<void> {
    const results = await Promise.allSettled(
      this.publishers.map((publisher) => publisher.publishMode(mode, availableModes))
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => toError(failure.reason)),
        "One or more Home Assistant audio publishers failed"
      );
    }
  }
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
