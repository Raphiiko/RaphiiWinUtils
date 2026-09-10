import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { getForegroundHelperPath } from "../system/paths.ts";
import { Logger } from "../system/logger.ts";

export interface ForegroundState {
  /** Lowercased process name without the extension, e.g. "photoshop". */
  process: string | null;
  title: string | null;
  pid: number;
}

export const NO_FOREGROUND: ForegroundState = { process: null, title: null, pid: 0 };

const RESTART_DELAY_MS = 1000;

/**
 * Wraps the ForegroundWatcher helper: which application holds the foreground,
 * and a keystroke sender aimed at whatever holds it.
 *
 * The helper owns a WinEvent hook, so this side is only a line reader. If the
 * helper dies it is restarted, and the foreground reads as unknown in between —
 * a stale app id would leave a context card up for an app that is not there.
 */
export class ForegroundWatcher {
  private readonly log: Logger;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private restartTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private state: ForegroundState = NO_FOREGROUND;
  private readonly listeners = new Set<(state: ForegroundState) => void>();

  constructor(logger: Logger) {
    this.log = logger.child("foreground");
  }

  current(): ForegroundState {
    return this.state;
  }

  subscribe(listener: (state: ForegroundState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.stopping = false;
    this.spawnHelper();
  }

  stop(): void {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.child?.kill();
    this.child = undefined;
    this.setState(NO_FOREGROUND);
  }

  /** Sends a key combination such as "ctrl+shift+m" to the foreground window. */
  sendHotkey(keys: string): boolean {
    if (!this.child?.stdin.writable) {
      this.log.warn("Hotkey dropped: helper not running", { keys });
      return false;
    }
    this.child.stdin.write(`${JSON.stringify({ type: "hotkey", keys })}\n`);
    return true;
  }

  private spawnHelper(): void {
    const helperPath = getForegroundHelperPath();
    if (!existsSync(helperPath)) {
      this.log.error("Helper missing; foreground reporting disabled", { helperPath });
      return;
    }

    const child = spawn(helperPath, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.log.warn("Helper stderr", { chunk: chunk.trim() }));
    child.on("error", (error) => this.log.error("Helper failed", { error: String(error) }));
    child.on("exit", (code) => {
      if (this.child === child) this.child = undefined;
      this.setState(NO_FOREGROUND);
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
    // A helper that never emits a newline must not grow the buffer forever.
    if (this.buffer.length > 64 * 1024) this.buffer = "";
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.log.warn("Unparsable helper line", { line: line.slice(0, 200) });
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type === "error") {
      this.log.warn("Helper reported an error", { message: String(record.message).slice(0, 400) });
      return;
    }
    if (record.type !== "foreground") return;
    this.setState({
      process: typeof record.process === "string" && record.process ? record.process : null,
      title: typeof record.title === "string" && record.title ? record.title : null,
      pid: typeof record.pid === "number" ? record.pid : 0
    });
  }

  private setState(next: ForegroundState): void {
    if (
      next.process === this.state.process &&
      next.title === this.state.title &&
      next.pid === this.state.pid
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (error) {
        this.log.warn("Foreground listener failed", { error: String(error) });
      }
    }
  }
}
