import { Subscription, interval, tap } from "rxjs";
import type { AppConfig } from "../config/schema";
import { AudioEndpointWatcher } from "../audio/audioEndpointWatcher";
import { mapEndpointsToChannels } from "../audio/channelMapper";
import type { ChannelState } from "../audio/types";
import { VbanTextClient } from "../matrix/vbanTextClient";
import { MatrixPresetSync } from "../matrix/matrixPresetSync";
import { Logger } from "../system/logger";

export class ChannelVolumeService {
  private readonly subscriptions = new Subscription();
  private readonly log: Logger;

  constructor(
    private readonly config: AppConfig,
    logger: Logger
  ) {
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
