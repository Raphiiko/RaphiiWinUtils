import {
  getText,
  hasText,
  setText,
  startWatch,
  type ClipboardWatcherJs
} from "@crosscopy/clipboard";
import type { ClipboardAutomationConfig } from "../config/schema";
import { patchClipboardLinks } from "../clipboard/linkReplacements";
import { Logger } from "../system/logger";

export interface TextClipboard {
  hasText(): boolean;
  readText(): Promise<string>;
  writeText(content: string): Promise<void>;
  watch(callback: () => void): { stop(): void };
}

export class ClipboardAutomationService {
  private readonly log: Logger;
  private readonly clipboard: TextClipboard;
  private watcher?: { stop(): void };
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private checkAgain = false;
  private lastObserved?: string;

  constructor(
    private readonly config: ClipboardAutomationConfig,
    logger: Logger,
    clipboard: TextClipboard = nativeClipboard
  ) {
    this.log = logger.child("clipboard");
    this.clipboard = clipboard;
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Clipboard automations disabled");
      return;
    }

    try {
      this.watcher = this.clipboard.watch(() => this.scheduleCheck());
      this.scheduleCheck();
      this.log.info("Clipboard automations started", { debounceMs: this.config.debounceMs });
    } catch (error) {
      this.log.warn("Clipboard automations could not start", { error: String(error) });
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.watcher?.stop();
    this.watcher = undefined;
  }

  private scheduleCheck(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => {
        this.debounceTimer = undefined;
        void this.checkClipboard();
      },
      Math.max(0, this.config.debounceMs)
    );
  }

  private async checkClipboard(): Promise<void> {
    if (this.busy) {
      this.checkAgain = true;
      return;
    }
    this.busy = true;

    try {
      if (!this.clipboard.hasText()) return;

      const content = await this.clipboard.readText();
      if (content === this.lastObserved) return;

      const patched = patchClipboardLinks(content);
      if (patched.content === content) {
        this.lastObserved = content;
        return;
      }

      await this.clipboard.writeText(patched.content);
      this.lastObserved = patched.content;
      this.log.info("Clipboard links updated", { rules: patched.appliedRules });
    } catch (error) {
      this.log.warn("Clipboard automation check failed", { error: String(error) });
    } finally {
      this.busy = false;
      if (this.checkAgain) {
        this.checkAgain = false;
        this.scheduleCheck();
      }
    }
  }
}

const nativeClipboard: TextClipboard = {
  hasText,
  readText: getText,
  writeText: setText,
  watch(callback: () => void): ClipboardWatcherJs {
    return startWatch(callback);
  }
};
