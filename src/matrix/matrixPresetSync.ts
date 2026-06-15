import {
  Subject,
  asyncScheduler,
  distinctUntilChanged,
  groupBy,
  map,
  mergeMap,
  throttleTime
} from "rxjs";
import type { ChannelState } from "../audio/types";
import { Logger } from "../system/logger";
import { VbanTextClient } from "./vbanTextClient";

export class MatrixPresetSync {
  private readonly updates$ = new Subject<ChannelState>();
  private readonly log: Logger;

  constructor(
    private readonly client: VbanTextClient,
    logger: Logger
  ) {
    this.log = logger.child("matrix-sync");
  }

  start(): void {
    this.updates$
      .pipe(
        groupBy((state) => state.presetPatch),
        mergeMap((group$) =>
          group$.pipe(
            distinctUntilChanged((a, b) => a.gainDb === b.gainDb && a.muted === b.muted),
            throttleTime(10, asyncScheduler, { leading: true, trailing: true }),
            map((state) => ({
              state,
              command: [
                `PresetPatch[${state.presetPatch}].Gain = ${state.gainDb.toFixed(1)};`,
                `PresetPatch[${state.presetPatch}].Mute = ${state.muted ? 1 : 0};`
              ].join("\n")
            }))
          )
        )
      )
      .subscribe({
        next: ({ state, command }) => {
          void this.client
            .send(command)
            .then(() => {
              this.log.debug("Synced channel to Matrix", {
                channel: state.channelName,
                presetPatch: state.presetPatch,
                volumePercent: state.endpoint.volumePercent,
                gainDb: state.gainDb,
                muted: state.muted
              });
            })
            .catch((error) => {
              this.log.error("Failed to sync channel to Matrix", {
                channel: state.channelName,
                error: String(error)
              });
            });
        },
        error: (error) => {
          this.log.error("Matrix sync stream failed", { error: String(error) });
        }
      });
  }

  sync(state: ChannelState): void {
    this.updates$.next(state);
  }
}
