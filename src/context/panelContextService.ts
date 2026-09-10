import type { PanelContextConfig } from "../config/schema.ts";
import type { ForegroundState } from "./foregroundWatcher.ts";
import type { ForegroundWatcher } from "./foregroundWatcher.ts";
import { Logger } from "../system/logger.ts";

/** What the desk panel renders a context card from. */
export interface PanelContext {
  app: string | null;
  title: string | null;
  photoshop: { brushSize: number; brushAngle: number } | null;
}

export const EMPTY_CONTEXT: PanelContext = { app: null, title: null, photoshop: null };

/**
 * Reads and writes Photoshop's live brush values.
 *
 * `read` is a cached snapshot, never a blocking call: the values come from
 * ExtendScript over COM, which costs ~200ms per round trip whatever it asks
 * for, so writes are fire-and-forget and the controller reports back through
 * `subscribe`. `refresh` asks for one read, used when Photoshop takes focus —
 * there is deliberately no polling, because the script runs on Photoshop's own
 * UI thread and would hitch the canvas.
 *
 * A null read means no usable values (Photoshop closed, or a non-brush tool
 * selected), and the panel hides the joggers rather than showing numbers that
 * do not match the canvas.
 */
export interface BrushController {
  read(): { brushSize: number; brushAngle: number } | null;
  refresh(): void;
  setSize(px: number): void;
  setAngle(degrees: number): void;
  subscribe(listener: () => void): () => void;
  /** Plays a saved Photoshop Action. */
  playAction(set: string, name: string): boolean;
}

/**
 * Photoshop's window title is "Adobe Photoshop 2026 - name.psd @ 66% (Layer 1,
 * RGB/8) *". Only the file name is worth showing on a 2560x720 panel, so strip
 * the product prefix and everything from the zoom marker on.
 */
export function photoshopDocument(title: string | null): string | null {
  if (!title) return null;
  const afterProduct = title.includes(" - ") ? title.slice(title.indexOf(" - ") + 3) : title;
  const document = (afterProduct.split(" @ ")[0] ?? "").trim();
  // Nothing stripped means the window carries no document, only the product
  // name, and showing "Adobe Photoshop 2026" as a document reads wrong.
  if (!document || document === title.trim()) return null;
  return document;
}

const DOCUMENT_READERS: Record<string, (title: string | null) => string | null> = {
  photoshop: photoshopDocument
};

/** "Kipfel/Symmetry Last" -> { set: "Kipfel", name: "Symmetry Last" }. */
function splitAction(value: string): { set: string; name: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { set: value.slice(0, slash), name: value.slice(slash + 1) };
}

export class PanelContextService {
  private readonly log: Logger;
  private readonly config: PanelContextConfig;
  private readonly watcher: ForegroundWatcher;
  private readonly brush?: BrushController;
  private readonly listeners = new Set<(context: PanelContext) => void>();
  private context: PanelContext = EMPTY_CONTEXT;
  private unsubscribe?: () => void;
  private unsubscribeBrush?: () => void;

  constructor(
    config: PanelContextConfig,
    watcher: ForegroundWatcher,
    logger: Logger,
    brush?: BrushController
  ) {
    this.config = config;
    this.watcher = watcher;
    this.brush = brush;
    this.log = logger.child("panel-context");
  }

  start(): void {
    this.unsubscribe = this.watcher.subscribe((state) => this.recompute(state));
    this.unsubscribeBrush = this.brush?.subscribe(() => this.publish());
    this.recompute(this.watcher.current());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeBrush?.();
    this.unsubscribeBrush = undefined;
  }

  snapshot(): PanelContext {
    return this.context;
  }

  subscribe(listener: (context: PanelContext) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies one panel command. Returns false when it is not wired up. */
  apply(app: string, command: string, value?: number): boolean {
    if (app !== this.context.app) {
      // The panel is showing a card for an app that no longer holds focus. A
      // hotkey now would land in whatever took over.
      this.log.warn("Command dropped: app is not focused", { app, command, focused: this.context.app });
      return false;
    }

    if (command === "setBrushSize" || command === "setBrushAngle") {
      if (!this.brush || value === undefined) {
        this.log.warn("Command dropped: no brush transport", { app, command });
        return false;
      }
      if (command === "setBrushSize") this.brush.setSize(value);
      else this.brush.setAngle(value);
      // The controller reports the applied value back through its own
      // subscription, so nothing is published here.
      return true;
    }

    // A saved Photoshop Action wins over a keystroke: it reaches commands that
    // have no assignable shortcut at all.
    const action = this.config.actions[`${app}.${command}`];
    if (action) {
      const parsed = splitAction(action);
      if (!parsed) {
        this.log.warn("Command dropped: action needs \"Set/Action\" form", { app, command, action });
        return false;
      }
      if (!this.brush) {
        this.log.warn("Command dropped: no Photoshop bridge", { app, command });
        return false;
      }
      return this.brush.playAction(parsed.set, parsed.name);
    }

    const keys = this.config.hotkeys[`${app}.${command}`];
    if (!keys) {
      this.log.warn("Command dropped: no hotkey or action configured", { app, command });
      return false;
    }
    return this.watcher.sendHotkey(keys);
  }

  private recompute(state: ForegroundState): void {
    const app = state.process ? (this.config.apps[state.process] ?? null) : null;
    if (!app) {
      this.setContext(EMPTY_CONTEXT);
      return;
    }
    const readDocument = DOCUMENT_READERS[app];
    // Photoshop just took focus, so its brush values may have changed while the
    // panel was not looking. One read, no polling.
    if (app === "photoshop" && this.context.app !== "photoshop") this.brush?.refresh();
    this.setContext({
      app,
      title: readDocument ? readDocument(state.title) : state.title,
      photoshop: app === "photoshop" ? (this.brush?.read() ?? null) : null
    });
  }

  private publish(): void {
    if (this.context.app !== "photoshop") return;
    this.setContext({ ...this.context, photoshop: this.brush?.read() ?? null });
  }

  private setContext(next: PanelContext): void {
    if (
      next.app === this.context.app &&
      next.title === this.context.title &&
      next.photoshop?.brushSize === this.context.photoshop?.brushSize &&
      next.photoshop?.brushAngle === this.context.photoshop?.brushAngle
    ) {
      return;
    }
    this.context = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (error) {
        this.log.warn("Context listener failed", { error: String(error) });
      }
    }
  }
}
