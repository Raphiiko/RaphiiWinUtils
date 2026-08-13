import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Logger } from "../system/logger.ts";

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
  private readonly pollMs: number;
  private readonly log: Logger;
  private timer?: ReturnType<typeof setInterval>;
  private onEvent: (event: DictationEvent) => void = () => {};
  private offset?: number;
  private remainder = "";
  private reading = false;
  private stopped = false;

  constructor(path: string, pollMs: number, logger: Logger) {
    this.path = path;
    this.pollMs = pollMs;
    this.log = logger.child("handy");
  }

  start(onEvent: (event: DictationEvent) => void): void {
    this.stopped = false;
    this.onEvent = onEvent;
    // Handy keeps its log file open, and Windows raises no change notification for a writer
    // that holds its handle, so fs.watch never fires here. Polling the size does see the writes.
    this.timer = setInterval(() => void this.readNewLines(), this.pollMs);
    this.log.info("Watching Handy log", { path: this.path, pollMs: this.pollMs });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async readNewLines(): Promise<void> {
    if (this.reading || this.stopped) return;
    if (!existsSync(this.path)) {
      this.offset = undefined;
      return;
    }

    this.reading = true;
    try {
      const size = (await stat(this.path)).size;
      if (this.offset === undefined) {
        // Only react to what happens from now on; the file holds days of past dictations.
        this.offset = size;
        this.remainder = "";
        return;
      }
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
}
