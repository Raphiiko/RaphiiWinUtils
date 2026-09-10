import { Logger } from "../system/logger.ts";

/**
 * The Photoshop-side half of the brush controls: a socket the Kipfel Bridge UXP
 * plugin connects to from inside Photoshop.
 *
 * This exists because Photoshop's COM interface cannot carry a live drag. Every
 * `DoJavaScript` call costs ~200ms of fixed overhead whatever it contains,
 * against these numbers measured through the plugin on Photoshop 27.10:
 *
 *   brush read                       0.8ms
 *   brush write, own modal scope     4.9ms
 *   brush write, shared modal scope  2.6ms
 *
 * So a jogger can stream at frame rate here, where over COM it could not send
 * more than two values a second. COM stays as the fallback for when Photoshop
 * is running without the plugin loaded.
 *
 * The plugin lives inside Photoshop and connects out to the control API on
 * 127.0.0.1, so this needs no token: nothing off-box can reach that listener.
 */
export interface PhotoshopBrush {
  brushSize: number;
  brushAngle: number;
}

interface Sink {
  send: (data: string) => unknown;
}

export class PhotoshopUxpLink {
  private readonly log: Logger;
  private sockets = new Map<string, Sink>();
  private brush: PhotoshopBrush | null = null;
  private listener?: (brush: PhotoshopBrush | null) => void;

  constructor(logger: Logger) {
    this.log = logger.child("photoshop-uxp");
  }

  get connected(): boolean {
    return this.sockets.size > 0;
  }

  read(): PhotoshopBrush | null {
    return this.brush;
  }

  onChange(listener: (brush: PhotoshopBrush | null) => void): void {
    this.listener = listener;
  }

  attach(id: string, socket: Sink): void {
    this.sockets.set(id, socket);
    this.log.info("Photoshop plugin connected", { sockets: this.sockets.size });
    this.send({ type: "read" });
  }

  detach(id: string): void {
    if (!this.sockets.delete(id)) return;
    this.log.info("Photoshop plugin disconnected", { sockets: this.sockets.size });
    if (!this.connected) this.publish(null);
  }

  /** Handles one message from the plugin. */
  handle(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    if (m.type !== "brush") return;
    const diameter = typeof m.diameter === "number" && Number.isFinite(m.diameter) ? m.diameter : null;
    const angle = typeof m.angle === "number" && Number.isFinite(m.angle) ? m.angle : null;
    this.publish(
      diameter === null || angle === null
        ? null
        : {
            brushSize: Math.max(1, Math.min(5000, Math.round(diameter))),
            brushAngle: ((Math.round(angle) % 360) + 360) % 360
          }
    );
  }

  /**
   * Sets both values. Photoshop resets a brush field an update omits, so the
   * caller passes the pair even when only one of them moved.
   */
  set(diameter: number, angle: number): boolean {
    return this.send({ type: "set", diameter, angle });
  }

  requestRead(): boolean {
    return this.send({ type: "read" });
  }

  private send(payload: Record<string, unknown>): boolean {
    if (!this.connected) return false;
    const data = JSON.stringify(payload);
    let sent = false;
    for (const [id, socket] of this.sockets) {
      try {
        socket.send(data);
        sent = true;
      } catch {
        this.sockets.delete(id);
      }
    }
    return sent;
  }

  private publish(next: PhotoshopBrush | null): void {
    if (next?.brushSize === this.brush?.brushSize && next?.brushAngle === this.brush?.brushAngle) return;
    this.brush = next;
    try {
      this.listener?.(next);
    } catch (error) {
      this.log.warn("Brush listener failed", { error: String(error) });
    }
  }
}
