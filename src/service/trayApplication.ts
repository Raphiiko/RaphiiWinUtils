import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { ControlConfig } from "../config/schema.ts";
import { getTrayApplicationPath } from "../system/paths.ts";
import { Logger } from "../system/logger.ts";

export class TrayApplication {
  private process?: ChildProcess;
  private readonly log: Logger;
  private readonly config: ControlConfig;

  constructor(config: ControlConfig, logger: Logger) {
    this.config = config;
    this.log = logger.child("tray");
  }

  start(): void {
    if (!this.config.enabled) return;

    const executable = getTrayApplicationPath();
    if (!existsSync(executable)) {
      this.log.warn("Tray helper is not built", { executable });
      return;
    }

    this.process = spawn(executable, [`http://${this.config.host}:${this.config.port}`], {
      windowsHide: true,
      stdio: "ignore"
    });
    this.process.once("error", (error) =>
      this.log.warn("Tray helper failed to start", { error: String(error) })
    );
    this.process.once("exit", (code) => {
      this.process = undefined;
      if (code) this.log.warn("Tray helper exited", { code });
    });
  }

  stop(): void {
    this.process?.kill();
    this.process = undefined;
  }
}
