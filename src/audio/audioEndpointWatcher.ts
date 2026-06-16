import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { Observable, share } from "rxjs";
import type { AudioEndpointState, AudioWatcherMessage } from "./types";
import { getHelperPath } from "../system/paths";
import { Logger } from "../system/logger";

const recentEventProtectionMs = 2500;
const restartDelayMs = 1000;
const volumeEpsilon = 0.00001;

export class AudioEndpointWatcher {
  private child?: ChildProcessWithoutNullStreams;
  private readonly log: Logger;

  constructor(
    private readonly endpointResyncMs: number,
    logger: Logger
  ) {
    this.log = logger.child("audio");
  }

  watch(): Observable<AudioEndpointState[]> {
    return new Observable<AudioEndpointState[]>((subscriber) => {
      let buffer = "";
      let restartTimer: ReturnType<typeof setTimeout> | undefined;
      let stopping = false;
      const latest = new Map<string, AudioEndpointState>();
      const lastEventAt = new Map<string, number>();

      const upsert = (endpoint: AudioEndpointState): boolean => {
        const previous = latest.get(endpoint.id);
        if (previous && sameEndpointState(previous, endpoint)) return false;
        latest.set(endpoint.id, endpoint);
        return true;
      };

      const publishEndpoint = (endpoint: AudioEndpointState) => {
        if (endpoint.source === "event") {
          lastEventAt.set(endpoint.id, Date.now());
        }

        if (!upsert(endpoint)) return;
        subscriber.next([...latest.values()]);
      };

      const publishSnapshot = (endpoints: AudioEndpointState[]) => {
        const now = Date.now();
        const snapshotIds = new Set(endpoints.map((endpoint) => endpoint.id));
        let changed = false;

        for (const endpoint of endpoints) {
          const recentEventAt = lastEventAt.get(endpoint.id);
          const hasRecentEvent =
            recentEventAt !== undefined && now - recentEventAt < recentEventProtectionMs;
          const current = latest.get(endpoint.id);

          if (hasRecentEvent && current && !sameEndpointState(current, endpoint)) {
            this.log.debug("Ignored stale poll snapshot after endpoint event", {
              name: endpoint.name,
              source: endpoint.source,
              currentVolumePercent: current.volumePercent,
              snapshotVolumePercent: endpoint.volumePercent,
              currentMuted: current.muted,
              snapshotMuted: endpoint.muted
            });
            continue;
          }

          changed = upsert(endpoint) || changed;
        }

        for (const id of latest.keys()) {
          if (snapshotIds.has(id)) continue;
          latest.delete(id);
          lastEventAt.delete(id);
          changed = true;
        }

        if (changed) subscriber.next([...latest.values()]);
      };

      const scheduleRestart = (reason: Record<string, unknown>) => {
        if (stopping || subscriber.closed || restartTimer) return;

        this.log.warn("Audio endpoint watcher stopped; restarting", {
          restartDelayMs,
          ...reason
        });
        restartTimer = setTimeout(() => {
          restartTimer = undefined;
          startChild();
        }, restartDelayMs);
      };

      const startChild = () => {
        const helperPath = getHelperPath();
        if (!existsSync(helperPath)) {
          scheduleRestart({ error: `Audio helper not found: ${helperPath}` });
          return;
        }

        buffer = "";
        const child = spawn(helperPath, [`--resync-ms=${this.endpointResyncMs}`], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        });
        this.child = child;

        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            if (!line) continue;

            try {
              const message = JSON.parse(line) as AudioWatcherMessage;
              if (message.type === "ready") {
                this.log.info("Audio endpoint watcher ready");
              } else if (message.type === "snapshot" && message.endpoints) {
                publishSnapshot(message.endpoints);
              } else if (message.type === "endpoint" && message.endpoint) {
                publishEndpoint(message.endpoint);
              } else if (message.type === "error") {
                this.log.warn("Audio watcher reported an error", { message: message.message });
              }
            } catch (error) {
              this.log.warn("Ignoring invalid audio watcher line", { line, error: String(error) });
            }
          }
        });

        child.stderr.on("data", (chunk: Buffer) => {
          this.log.warn("Audio watcher stderr", { message: chunk.toString("utf8").trim() });
        });

        child.on("error", (error) => {
          if (this.child === child) this.child = undefined;
          scheduleRestart({ error: String(error) });
        });

        child.on("exit", (code, signal) => {
          if (this.child === child) this.child = undefined;
          if (!stopping) scheduleRestart({ code, signal });
        });
      };

      startChild();

      return () => {
        stopping = true;
        if (restartTimer) clearTimeout(restartTimer);
        this.child?.kill();
        this.child = undefined;
      };
    }).pipe(share());
  }
}

function sameEndpointState(a: AudioEndpointState, b: AudioEndpointState): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.dataFlow === b.dataFlow &&
    Math.abs(a.volumeScalar - b.volumeScalar) < volumeEpsilon &&
    a.muted === b.muted
  );
}
