import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { Observable, share } from "rxjs";
import type { AudioEndpointState, AudioWatcherMessage } from "./types";
import { getHelperPath } from "../system/paths";
import { Logger } from "../system/logger";

export class AudioEndpointWatcher {
  private child?: ChildProcessWithoutNullStreams;
  private readonly log: Logger;

  constructor(
    private readonly pollMs: number,
    logger: Logger
  ) {
    this.log = logger.child("audio");
  }

  watch(): Observable<AudioEndpointState[]> {
    return new Observable<AudioEndpointState[]>((subscriber) => {
      const helperPath = getHelperPath();
      if (!existsSync(helperPath)) {
        subscriber.error(new Error(`Audio helper not found: ${helperPath}`));
        return;
      }

      this.child = spawn(helperPath, [`--poll-ms=${this.pollMs}`], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let buffer = "";
      const latest = new Map<string, AudioEndpointState>();

      const publish = (endpoint: AudioEndpointState) => {
        latest.set(endpoint.id, endpoint);
        subscriber.next([...latest.values()]);
      };

      this.child.stdout.on("data", (chunk: Buffer) => {
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
              latest.clear();
              for (const endpoint of message.endpoints) latest.set(endpoint.id, endpoint);
              subscriber.next([...latest.values()]);
            } else if (message.type === "endpoint" && message.endpoint) {
              publish(message.endpoint);
            } else if (message.type === "error") {
              this.log.warn("Audio watcher reported an error", { message: message.message });
            }
          } catch (error) {
            this.log.warn("Ignoring invalid audio watcher line", { line, error: String(error) });
          }
        }
      });

      this.child.stderr.on("data", (chunk: Buffer) => {
        this.log.warn("Audio watcher stderr", { message: chunk.toString("utf8").trim() });
      });

      this.child.on("error", (error) => {
        subscriber.error(error);
      });

      this.child.on("exit", (code, signal) => {
        if (!subscriber.closed) {
          subscriber.error(new Error(`Audio watcher exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
        }
      });

      return () => {
        this.child?.kill();
        this.child = undefined;
      };
    }).pipe(share());
  }
}
