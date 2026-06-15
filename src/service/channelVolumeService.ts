import { Subscription, tap } from "rxjs";
import type { AppConfig } from "../config/schema";
import { AudioEndpointWatcher } from "../audio/audioEndpointWatcher";
import { mapEndpointsToChannels } from "../audio/channelMapper";
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
    const watcher = new AudioEndpointWatcher(this.config.audio.pollMs, this.log);
    const matrixClient = new VbanTextClient(this.config.matrix, this.log);
    const matrixSync = new MatrixPresetSync(matrixClient, this.log);
    matrixSync.start();

    const endpoints$ = watcher.watch();
    const seenEndpoints = new Set<string>();

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
        .subscribe()
    );

    this.subscriptions.add(
      mapEndpointsToChannels(endpoints$, this.config.audio)
        .subscribe({
          next: (state) => matrixSync.sync(state),
          error: (error) => {
            this.log.error("Channel volume service failed", { error: String(error) });
          }
        })
    );
  }

  stop(): void {
    this.subscriptions.unsubscribe();
  }
}
