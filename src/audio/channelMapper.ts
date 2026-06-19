import { distinctUntilChanged, map, mergeMap, type Observable } from "rxjs";
import type { AudioConfig } from "../config/schema.ts";
import type { AudioEndpointState, ChannelState } from "./types.ts";

export function mapEndpointsToChannels(
  endpointSnapshots$: Observable<AudioEndpointState[]>,
  config: AudioConfig
): Observable<ChannelState> {
  return endpointSnapshots$.pipe(
    map((endpoints) =>
      config.channels
        .map((channel) => {
          const endpoint = endpoints.find(
            (candidate) =>
              candidate.dataFlow === "Render" &&
              candidate.name.toLowerCase().includes(channel.endpointNameContains.toLowerCase())
          );

          if (!endpoint) return undefined;

          const gainDb = scalarToDb(endpoint.volumeScalar, config.minDb, config.maxDb);
          const muted =
            endpoint.muted || (config.zeroVolumeMutes && endpoint.volumeScalar <= 0.0001);

          return {
            channelName: channel.name,
            presetPatch: channel.presetPatch,
            endpoint,
            gainDb,
            muted
          } satisfies ChannelState;
        })
        .filter((state): state is ChannelState => state !== undefined)
    ),
    map((states) => states.sort((a, b) => a.presetPatch - b.presetPatch)),
    map((states) =>
      states.map((state) => ({
        ...state,
        gainDb: Number(state.gainDb.toFixed(1))
      }))
    ),
    mergeMap((states) => states),
    distinctUntilChanged(
      (a, b) => a.presetPatch === b.presetPatch && a.gainDb === b.gainDb && a.muted === b.muted
    )
  );
}

export function scalarToDb(scalar: number, minDb: number, maxDb: number): number {
  const clampedScalar = Math.max(0, Math.min(1, scalar));
  return minDb + clampedScalar * (maxDb - minDb);
}
