import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import type { ClipboardAutomationConfig } from "../config/schema";
import { patchClipboardLinks } from "../clipboard/linkReplacements";
import { getClipboardHelperPath } from "../system/paths";
import { Logger } from "../system/logger";

const restartDelayMs = 1000;

interface ClipboardWatcherMessage {
  type: "ready" | "text" | "error";
  content?: string;
  message?: string;
}

export class ClipboardAutomationService {
  private readonly log: Logger;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private restartTimer?: ReturnType<typeof setTimeout>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private pendingContent?: string;
  private stopping = false;
  private busy = false;
  private checkAgain = false;
  private lastObserved?: string;

  constructor(
    private readonly config: ClipboardAutomationConfig,
    logger: Logger
  ) {
    this.log = logger.child("clipboard");
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Clipboard automations disabled");
      return;
    }

    this.startChild();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.child?.kill();
    this.child = undefined;
  }

  private startChild(): void {
    const helperPath = getClipboardHelperPath();
    if (!existsSync(helperPath)) {
      this.scheduleRestart({ error: `Clipboard helper not found: ${helperPath}` });
      return;
    }

    this.buffer = "";
    const child = spawn(helperPath, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        newlineIndex = this.buffer.indexOf("\n");
        if (!line) continue;
        this.handleLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.log.warn("Clipboard watcher stderr", { message: chunk.toString("utf8").trim() });
    });

    child.on("error", (error) => {
      if (this.child === child) this.child = undefined;
      this.scheduleRestart({ error: String(error) });
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (!this.stopping) this.scheduleRestart({ code, signal });
    });
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as ClipboardWatcherMessage;
      if (message.type === "ready") {
        this.log.info("Clipboard watcher ready");
      } else if (message.type === "text" && message.content !== undefined) {
        this.pendingContent = message.content;
        this.scheduleCheck();
      } else if (message.type === "error") {
        this.log.warn("Clipboard watcher reported an error", { message: message.message });
      }
    } catch (error) {
      this.log.warn("Ignoring invalid clipboard watcher line", { line, error: String(error) });
    }
  }

  private scheduleCheck(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => {
        this.debounceTimer = undefined;
        this.checkClipboard();
      },
      Math.max(0, this.config.debounceMs)
    );
  }

  private checkClipboard(): void {
    if (this.busy) {
      this.checkAgain = true;
      return;
    }

    const content = this.pendingContent;
    this.pendingContent = undefined;
    if (content === undefined || content === this.lastObserved) return;

    this.busy = true;
    try {
      const patched = patchClipboardLinks(content);
      if (patched.content === content) {
        this.lastObserved = content;
        return;
      }

      this.writeClipboardText(patched.content);
      this.lastObserved = patched.content;
      this.log.info("Clipboard links updated", { rules: patched.appliedRules });
    } finally {
      this.busy = false;
      if (this.checkAgain || this.pendingContent !== undefined) {
        this.checkAgain = false;
        this.scheduleCheck();
      }
    }
  }

  private writeClipboardText(content: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      this.log.warn("Cannot update clipboard because watcher is not running");
      return;
    }

    child.stdin.write(`${JSON.stringify({ type: "setText", content })}\n`, "utf8");
  }

  private scheduleRestart(reason: Record<string, unknown>): void {
    if (this.stopping || this.restartTimer) return;

    this.log.warn("Clipboard watcher stopped; restarting", {
      restartDelayMs,
      ...reason
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.startChild();
    }, restartDelayMs);
  }
}
