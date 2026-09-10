import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { getPhotoshopBridgePath } from "../system/paths.ts";
import { Logger } from "../system/logger.ts";
import type { BrushController } from "./panelContextService.ts";

const RESTART_DELAY_MS = 2000;
// A write lands in ~500ms. Well past that, assume the reply is never coming
// (Photoshop mid-modal, or a script that never returned) and let the next
// command through rather than wedging the pipeline for the session.
const REPLY_TIMEOUT_MS = 15000;

/**
 * Photoshop's brush size and angle, over the PhotoshopBridge helper.
 *
 * Photoshop answers these only through ExtendScript, and every DoJavaScript
 * call costs ~200ms of fixed overhead whatever it contains (measured: 203ms for
 * `"x";`, against 1.7ms for a direct COM property). A read lands in ~250ms and
 * a write in ~500ms.
 *
 * So this never queues. At most one command is in flight, and a drag's newest
 * value replaces any waiting one — the panel's readout is instant either way,
 * and Photoshop converges on the value the finger stopped at instead of
 * replaying every intermediate step minutes late.
 *
 * Reads happen on request only, never on a timer: the script runs on
 * Photoshop's own UI thread, so polling would hitch the canvas every few
 * seconds while painting.
 */
export class PhotoshopBrushController implements BrushController {
  private readonly log: Logger;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private restartTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private brush: { brushSize: number; brushAngle: number } | null = null;
  private inFlight = false;
  // What the panel wants, tracked separately from what Photoshop confirmed: a
  // write takes ~500ms, so `brush` is still the old value when the next drag
  // step arrives and computing from it would undo the one in flight.
  private intended: { diameter: number; angle: number } | null = null;
  private dirty = false;
  private wantRead = false;
  private replyTimer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<() => void>();

  constructor(logger: Logger) {
    this.log = logger.child("photoshop");
  }

  start(): void {
    this.stopping = false;
    this.spawnHelper();
  }

  stop(): void {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.replyTimer);
    this.child?.kill();
    this.child = undefined;
    this.brush = null;
  }

  read(): { brushSize: number; brushAngle: number } | null {
    return this.brush;
  }

  refresh(): void {
    this.wantRead = true;
    this.pump();
  }

  setSize(px: number): void {
    this.queue({ diameter: px });
  }

  setAngle(degrees: number): void {
    this.queue({ angle: degrees });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private queue(patch: { diameter?: number; angle?: number }): void {
    if (!this.intended) {
      // No baseline yet, and Photoshop resets whatever a `set` leaves out — so
      // read the real values first rather than guessing at the other field.
      this.log.warn("Brush write dropped: no value read yet");
      this.wantRead = true;
      this.pump();
      return;
    }
    this.intended = { ...this.intended, ...patch };
    this.dirty = true;
    this.pump();
  }

  private pump(): void {
    if (this.inFlight || !this.child?.stdin.writable) return;
    let command: unknown;
    if (this.dirty && this.intended) {
      // Always both fields. See the helper: a partial set drops the omitted one
      // to its default.
      command = { type: "set", ...this.intended };
      this.dirty = false;
    } else if (this.wantRead) {
      command = { type: "read" };
      this.wantRead = false;
    } else {
      return;
    }
    this.inFlight = true;
    clearTimeout(this.replyTimer);
    this.replyTimer = setTimeout(() => {
      this.log.warn("Photoshop did not reply; releasing the pipeline");
      this.inFlight = false;
      this.pump();
    }, REPLY_TIMEOUT_MS);
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Plays a saved Photoshop Action. Returns false when the helper is down. */
  playAction(set: string, name: string): boolean {
    if (!this.child?.stdin.writable) {
      this.log.warn("Action dropped: helper not running", { set, name });
      return false;
    }
    this.child.stdin.write(`${JSON.stringify({ type: "action", set, name })}\n`);
    return true;
  }

  private spawnHelper(): void {
    const helperPath = getPhotoshopBridgePath();
    if (!existsSync(helperPath)) {
      this.log.error("Helper missing; Photoshop controls disabled", { helperPath });
      return;
    }
    const child = spawn(helperPath, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    this.inFlight = false;
    this.intended = null;
    this.dirty = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.log.warn("Helper stderr", { chunk: chunk.trim() }));
    child.on("error", (error) => this.log.error("Helper failed", { error: String(error) }));
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      this.inFlight = false;
      this.intended = null;
      this.dirty = false;
      this.setBrush(null);
      if (this.stopping) return;
      this.log.warn("Helper exited; restarting", { code });
      this.restartTimer = setTimeout(() => this.spawnHelper(), RESTART_DELAY_MS);
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 64 * 1024) this.buffer = "";
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.log.warn("Unparsable helper line", { line: line.slice(0, 200) });
      return;
    }

    switch (message.type) {
      case "brush": {
        const diameter = typeof message.diameter === "number" ? message.diameter : null;
        const angle = typeof message.angle === "number" ? message.angle : null;
        this.setBrush(
          diameter === null || angle === null
            ? null
            : {
                brushSize: Math.max(1, Math.min(5000, Math.round(diameter))),
                brushAngle: ((Math.round(angle) % 360) + 360) % 360
              }
        );
        break;
      }
      case "unavailable":
        this.setBrush(null);
        break;
      case "actionDone":
        break;
      case "error":
        this.log.warn("Photoshop reported an error", { message: String(message.message).slice(0, 300) });
        break;
      default:
        return;
    }

    // Only brush replies answer a pumped command. An action is sent out of band,
    // and clearing the flag for it would let a second
    // brush write into the helper's queue while the first still runs.
    if (message.type === "brush" || message.type === "unavailable" || message.type === "error") {
      clearTimeout(this.replyTimer);
      this.inFlight = false;
      this.pump();
    }
  }

  private setBrush(next: { brushSize: number; brushAngle: number } | null): void {
    // Adopt Photoshop's values as the new baseline whenever nothing is waiting
    // to be written, so a change made with `[`/`]` or the canvas HUD is not
    // overwritten by a stale intent on the next drag.
    if (next && !this.dirty) this.intended = { diameter: next.brushSize, angle: next.brushAngle };
    if (next?.brushSize === this.brush?.brushSize && next?.brushAngle === this.brush?.brushAngle) return;
    this.brush = next;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.log.warn("Brush listener failed", { error: String(error) });
      }
    }
  }
}
