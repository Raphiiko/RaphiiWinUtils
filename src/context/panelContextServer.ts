import { Elysia, t } from "elysia";
import { node } from "@elysiajs/node";
import type { PanelContextConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import { ForegroundWatcher } from "./foregroundWatcher.ts";
import { PanelContextService, type PanelContext } from "./panelContextService.ts";
import { PhotoshopBrushController } from "./photoshopBrush.ts";
import type { PhotoshopUxpLink } from "./photoshopUxpLink.ts";

interface PanelCommand {
  type: "command";
  app: string;
  command: string;
  value?: number;
}

/**
 * Serves the kipfel desk panel's context socket.
 *
 * Its own listener, off-box by design, so it does NOT share the control API's
 * port: those routes have no auth and stay on 127.0.0.1. Here every connection
 * presents the shared token, and a missing or wrong one is closed immediately.
 *
 * The socket pushes a context snapshot on connect and on every change, and
 * accepts one command shape back. It is not a request/response API: the panel
 * renders whatever the last snapshot said.
 */
export class PanelContextServer {
  private readonly log: Logger;
  private readonly config: PanelContextConfig;
  private readonly watcher: ForegroundWatcher;
  private readonly service: PanelContextService;
  private readonly brush: PhotoshopBrushController;
  // Keyed by ws.id, not by the wrapper object: Elysia hands a fresh wrapper to
  // each event, so an identity check in `message` never matches the one seen
  // in `open` and every command is silently dropped.
  private readonly sockets = new Map<string, { send: (data: string) => unknown }>();
  private app?: { stop: () => unknown };
  private unsubscribe?: () => void;

  constructor(config: PanelContextConfig, logger: Logger, uxp: PhotoshopUxpLink) {
    this.config = config;
    this.log = logger.child("panel-server");
    this.watcher = new ForegroundWatcher(logger);
    this.brush = new PhotoshopBrushController(logger, uxp);
    this.service = new PanelContextService(config, this.watcher, logger, this.brush);
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Panel context disabled");
      return;
    }
    if (!this.config.token) {
      this.log.error("Panel context has no token; refusing to listen");
      return;
    }

    this.watcher.start();
    this.brush.start();
    this.service.start();
    this.unsubscribe = this.service.subscribe((context) => this.push(context));

    this.app = new Elysia({ adapter: node() })
      .ws("/panel/ws", {
        parse: (_ws, message) =>
          typeof message === "string"
            ? (JSON.parse(message) as PanelCommand)
            : (message as PanelCommand),
        body: t.Object({
          type: t.Literal("command"),
          app: t.String(),
          command: t.String(),
          value: t.Optional(t.Number())
        }),
        open: (ws) => {
          if (!this.authorized(ws)) {
            this.log.warn("Rejected a panel socket with a bad token");
            ws.close();
            return;
          }
          this.sockets.set(ws.id, ws);
          // Snapshot on connect: the panel has no state of its own, so without
          // this it would show nothing until the foreground next changed.
          ws.send(JSON.stringify({ type: "context", ...this.service.snapshot() }));
          this.log.info("Panel connected", { sockets: this.sockets.size });
        },
        message: (ws, message) => {
          // Re-checked per message rather than trusting a remembered socket:
          // the token lives on the connection, so this cannot go stale.
          if (!this.authorized(ws)) return;
          this.service.apply(message.app, message.command, message.value);
        },
        close: (ws) => {
          this.sockets.delete(ws.id);
        }
      })
      .listen({ hostname: this.config.host, port: this.config.port });

    this.log.info("Panel context listening", { host: this.config.host, port: this.config.port });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.sockets.clear();
    this.service.stop();
    this.brush.stop();
    this.watcher.stop();
    this.app?.stop();
    this.app = undefined;
  }

  private authorized(ws: { data: unknown }): boolean {
    const query = (ws.data as { query?: Record<string, string | undefined> }).query;
    return !!this.config.token && query?.token === this.config.token;
  }

  private push(context: PanelContext): void {
    const payload = JSON.stringify({ type: "context", ...context });
    for (const [id, ws] of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(id);
      }
    }
  }
}
