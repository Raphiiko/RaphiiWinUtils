import { Subscription, interval, tap } from "rxjs";
import type { AppConfig } from "../config/schema.ts";
import { AudioEndpointWatcher } from "../audio/audioEndpointWatcher.ts";
import { mapEndpointsToChannels } from "../audio/channelMapper.ts";
import type { ChannelState } from "../audio/types.ts";
import { VbanTextClient } from "../matrix/vbanTextClient.ts";
import { MatrixPresetSync } from "../matrix/matrixPresetSync.ts";
import { Logger } from "../system/logger.ts";

export class ChannelVolumeService {
  private readonly subscriptions = new Subscription();
  private readonly log: Logger;
  private readonly config: AppConfig;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.log = logger.child("channel-volume");
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
          matrixSync.sync(state);
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
  }
}
