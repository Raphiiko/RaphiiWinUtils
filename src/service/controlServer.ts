import { Elysia } from "elysia";
import type { ControlConfig } from "../config/schema";
import { Logger } from "../system/logger";
import type { Updater } from "./updater";

export class ControlServer {
  private readonly log: Logger;
  private app?: { stop: () => unknown };

  constructor(
    private readonly config: ControlConfig,
    private readonly updater: Updater,
    logger: Logger
  ) {
    this.log = logger.child("control");
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Control API disabled");
      return;
    }

    this.app = new Elysia()
      .get("/health", () => ({
        ok: true,
        service: "RaphiiWinUtils",
        updater: this.updater.getStatus()
      }))
      .post("/update/check", ({ set }) => {
        const accepted = this.updater.requestCheck("control-api");
        set.status = accepted ? 202 : 409;
        return {
          accepted,
          updater: this.updater.getStatus()
        };
      })
      .listen({
        hostname: this.config.host,
        port: this.config.port
      });

    this.log.info("Control API listening", {
      host: this.config.host,
      port: this.config.port
    });
  }

  stop(): void {
    this.app?.stop();
    this.app = undefined;
  }
}
