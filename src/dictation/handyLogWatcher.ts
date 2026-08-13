import { existsSync, watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Logger } from "../system/logger.ts";

const retryDelayMs = 5000;

export type DictationEvent = "start" | "stop";

/**
 * Handy has no event API. These are the log lines it writes on every dictation, and the
 * start marker only exists while Handy's log level is debug.
 */
export function parseHandyLogLine(line: string): DictationEvent | undefined {
  if (line.includes("TranscribeAction::start called")) return "start";
  if (line.includes("TranscribeAction::stop called")) return "stop";
  if (line.includes("Initiating operation cancellation")) return "stop";
  return undefined;
}

export class HandyLogWatcher {
  private readonly path: string;
  private readonly log: Logger;
  private watcher?: FSWatcher;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private onEvent: (event: DictationEvent) => void = () => {};
  private offset = 0;
  private remainder = "";
  private reading = false;
  private readAgain = false;
  private stopped = false;

  constructor(path: string, logger: Logger) {
    this.path = path;
    this.log = logger.child("handy");
  }

  start(onEvent: (event: DictationEvent) => void): void {
    this.stopped = false;
    this.onEvent = onEvent;
    void this.attach();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async attach(): Promise<void> {
    if (this.stopped) return;

    if (!existsSync(this.path)) {
      this.scheduleRetry("Handy log not found");
      return;
    }

    try {
      // Only react to what happens from now on; the file holds days of past dictations.
      this.offset = (await stat(this.path)).size;
      this.remainder = "";
      this.watcher = watch(this.path, (eventType) => {
        if (eventType === "rename") {
          this.watcher?.close();
          this.watcher = undefined;
          this.scheduleRetry("Handy log was replaced");
          return;
        }
        void this.readNewLines();
      });
      this.watcher.on("error", (error) => {
        this.watcher?.close();
        this.watcher = undefined;
        this.scheduleRetry(`Handy log watch failed: ${String(error)}`);
      });
      this.log.info("Watching Handy log", { path: this.path });
    } catch (error) {
      this.scheduleRetry(`Could not watch Handy log: ${String(error)}`);
    }
  }

  private async readNewLines(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return;
    }

    this.reading = true;
    try {
      const size = (await stat(this.path)).size;
      // Handy truncates its log on start, which would otherwise leave us reading past the end.
      if (size < this.offset) {
        this.offset = 0;
        this.remainder = "";
      }
      if (size === this.offset) return;

      const handle = await open(this.path, "r");
      try {
        const buffer = Buffer.alloc(size - this.offset);
        await handle.read(buffer, 0, buffer.length, this.offset);
        this.offset = size;
        this.consume(buffer.toString("utf8"));
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.log.warn("Failed to read Handy log", { error: String(error) });
    } finally {
      this.reading = false;
      if (this.readAgain) {
        this.readAgain = false;
        void this.readNewLines();
      }
    }
  }

  private consume(chunk: string): void {
    const lines = (this.remainder + chunk).split("\n");
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseHandyLogLine(line);
      if (event) this.onEvent(event);
    }
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped || this.retryTimer) return;

    this.log.warn(reason, { retryDelayMs, path: this.path });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.attach();
    }, retryDelayMs);
  }
}
