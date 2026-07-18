import { Subscription, interval, tap } from "rxjs";
import type { AppConfig } from "../config/schema.ts";
import { AudioEndpointWatcher } from "../audio/audioEndpointWatcher.ts";
import { mapEndpointsToChannels } from "../audio/channelMapper.ts";
import {
  WindowsAudioEndpointVolumeController,
  type AudioEndpointVolumeController,
  type AudioEndpointVolumePolicy
} from "../audio/audioEndpointVolumeController.ts";
import type { ChannelState } from "../audio/types.ts";
import { VbanTextClient } from "../matrix/vbanTextClient.ts";
import { MatrixPresetSync } from "../matrix/matrixPresetSync.ts";
import { Logger } from "../system/logger.ts";

export class ChannelVolumeService {
  private readonly subscriptions = new Subscription();
  private readonly log: Logger;
  private readonly config: AppConfig;
  private readonly volumeController: AudioEndpointVolumeController;
  private readonly latestStates = new Map<string, ChannelState>();
  private readonly listeners = new Set<(state: ChannelState) => void>();

  constructor(
    config: AppConfig,
    logger: Logger,
    volumeController: AudioEndpointVolumeController = new WindowsAudioEndpointVolumeController(
      logger
    )
  ) {
    this.config = config;
    this.log = logger.child("channel-volume");
    this.volumeController = volumeController;
  }

  start(): void {
    const watcher = new AudioEndpointWatcher(this.config.audio.endpointResyncMs, this.log);
    const matrixClient = new VbanTextClient(this.config.matrix, this.log);
    const matrixSync = new MatrixPresetSync(matrixClient, this.log);
    matrixSync.start();

    const endpoints$ = watcher.watch();
    const seenEndpoints = new Set<string>();
    const latestChannelStates = new Map<number, ChannelState>();

    this.subscriptions.add(
      endpoints$
        .pipe(
          tap((endpoints) => {
            for (const endpoint of endpoints) {
              if (seenEndpoints.has(endpoint.id)) continue;
              seenEndpoints.add(endpoint.id);
              this.log.info("Audio endpoint detected", {
                name: endpoint.name,
                dataFlow: endpoint.dataFlow,
                volumePercent: endpoint.volumePercent,
                muted: endpoint.muted
              });
            }
          })
        )
        .subscribe({
          error: (error) => {
            this.log.error("Audio endpoint logging stream failed", { error: String(error) });
          }
        })
    );

    this.subscriptions.add(
      mapEndpointsToChannels(endpoints$, this.config.audio).subscribe({
        next: (state) => {
          latestChannelStates.set(state.presetPatch, state);
          this.latestStates.set(state.channelName, state);
          matrixSync.sync(state);
          for (const listener of this.listeners) listener(state);
        },
        error: (error) => {
          this.log.error("Channel volume service failed", { error: String(error) });
        }
      })
    );

    if (this.config.matrix.resyncEveryMs > 0) {
      this.subscriptions.add(
        interval(this.config.matrix.resyncEveryMs).subscribe(() => {
          for (const state of latestChannelStates.values()) {
            matrixSync.sync(state, { force: true });
          }
        })
      );
    }
  }

  stop(): void {
    this.subscriptions.unsubscribe();
    this.latestStates.clear();
  }

  listStates(): ChannelState[] {
    return [...this.latestStates.values()].sort((a, b) => a.presetPatch - b.presetPatch);
  }

  configuredChannelNames(): string[] {
    return this.config.audio.channels.map((channel) => channel.name);
  }

  /**
   * Avoid launching the slow one-shot Windows policy helper when the persistent
   * watcher already has a fresh reading proving a policy is a no-op. Unknown
   * endpoints remain in the result so the mode switch stays conservative.
   */
  policiesThatNeedApply(policies: AudioEndpointVolumePolicy[]): AudioEndpointVolumePolicy[] {
    return policies.filter((policy) => {
      const state = this.listStates().find((candidate) =>
        candidate.endpoint.name.toLowerCase().includes(policy.endpointNameContains.toLowerCase())
      );
      if (!state) return true;

      const currentPercent = state.endpoint.volumePercent;
      return policy.mode === "cap"
        ? currentPercent > policy.volumePercent
        : currentPercent !== policy.volumePercent;
    });
  }

  onStateChange(listener: (state: ChannelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setVolume(channelName: string, volumePercent: number): Promise<void> {
    const channel = this.config.audio.channels.find(
      (candidate) => candidate.name.toLowerCase() === channelName.toLowerCase()
    );
    if (!channel) throw new UnknownAudioChannelError(channelName);
    if (!Number.isInteger(volumePercent) || volumePercent < 0 || volumePercent > 100) {
      throw new InvalidAudioVolumeError(volumePercent);
    }

    await this.volumeController.apply([
      {
        endpointNameContains: channel.endpointNameContains,
        volumePercent,
        mode: "set"
      }
    ]);
  }
}

export class UnknownAudioChannelError extends Error {
  constructor(channelName: string) {
    super(`Unknown audio channel: ${channelName}`);
  }
}

export class InvalidAudioVolumeError extends Error {
  constructor(volumePercent: number) {
    super(`Audio volume must be an integer from 0 to 100, received: ${volumePercent}`);
  }
}
