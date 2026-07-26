import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { Observable, share } from "rxjs";
import type {
  AudioEndpointState,
  AudioEndpointVolumePolicyResult,
  AudioWatcherMessage
} from "./types.ts";
import { getHelperPath } from "../system/paths.ts";
import { Logger } from "../system/logger.ts";

const recentEventProtectionMs = 2500;
const restartDelayMs = 1000;
const volumeEpsilon = 0.00001;

export class AudioEndpointWatcher {
  private child?: ChildProcessWithoutNullStreams;
  private nextRequestId = 0;
  private readonly pendingVolumeRequests = new Map<
    string,
    {
      resolve: (results: AudioEndpointVolumePolicyResult[]) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly log: Logger;
  private readonly endpointResyncMs: number;

  constructor(endpointResyncMs: number, logger: Logger) {
    this.endpointResyncMs = endpointResyncMs;
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
              } else if (message.type === "volume-policy-result" && message.requestId) {
                const request = this.pendingVolumeRequests.get(message.requestId);
                if (!request) continue;
                clearTimeout(request.timeout);
                this.pendingVolumeRequests.delete(message.requestId);
                if (message.error) request.reject(new Error(message.error));
                else request.resolve(message.results ?? []);
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
          this.rejectPendingVolumeRequests(error);
          scheduleRestart({ error: String(error) });
        });

        child.on("exit", (code, signal) => {
          if (this.child === child) this.child = undefined;
          this.rejectPendingVolumeRequests(
            new Error(`Audio endpoint watcher exited (${code ?? signal ?? "unknown"})`)
          );
          if (!stopping) scheduleRestart({ code, signal });
        });
      };

      startChild();

      return () => {
        stopping = true;
        if (restartTimer) clearTimeout(restartTimer);
        this.child?.kill();
        this.child = undefined;
        this.rejectPendingVolumeRequests(new Error("Audio endpoint watcher stopped"));
      };
    }).pipe(share());
  }

  setVolume(
    endpointNameContains: string,
    volumePercent: number,
    endpointId?: string
  ): Promise<AudioEndpointVolumePolicyResult[]> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error("Audio endpoint watcher is not ready"));
    }

    const requestId = String(++this.nextRequestId);
    const command = JSON.stringify({
      type: "apply-volume-policy",
      requestId,
      endpointNameContains,
      endpointId,
      volumePercent,
      mode: "set"
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingVolumeRequests.delete(requestId);
        reject(new Error("Audio endpoint volume command timed out"));
        if (this.child === child) child.kill();
      }, 10_000);
      this.pendingVolumeRequests.set(requestId, { resolve, reject, timeout });
      child.stdin.write(`${command}\n`, (error) => {
        if (!error) return;
        const request = this.pendingVolumeRequests.get(requestId);
        if (!request) return;
        clearTimeout(request.timeout);
        this.pendingVolumeRequests.delete(requestId);
        reject(error);
      });
    });
  }

  private rejectPendingVolumeRequests(error: Error): void {
    for (const request of this.pendingVolumeRequests.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pendingVolumeRequests.clear();
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
