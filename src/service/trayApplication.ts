import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { ControlConfig } from "../config/schema.ts";
import { getTrayApplicationPath } from "../system/paths.ts";
import { Logger } from "../system/logger.ts";

export class TrayApplication {
  private process?: ChildProcess;
  private restartTimer?: NodeJS.Timeout;
  private stopping = false;
  private readonly log: Logger;
  private readonly config: ControlConfig;
  private readonly onQuit: () => void;

  constructor(config: ControlConfig, logger: Logger, onQuit: () => void) {
    this.onQuit = onQuit;
    this.config = config;
    this.log = logger.child("tray");
  }

  start(): void {
    if (!this.config.enabled || this.process) return;

    this.stopping = false;

    const executable = getTrayApplicationPath();
    const url = new URL(`http://${this.config.host}:${this.config.port}`);
    url.searchParams.set("tray", "1");
    if (!existsSync(executable)) {
      this.log.warn("Tray helper is not built", { executable });
      return;
    }

    this.process = spawn(executable, [url.toString()], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    this.process.stderr?.on("data", (data: Buffer) =>
      this.log.warn("Tray diagnostic", { message: data.toString().trim() })
    );
    this.process.once("error", (error) =>
      this.log.warn("Tray helper failed to start", { error: String(error) })
    );
    this.process.once("close", (code) => {
      this.process = undefined;
      if (this.stopping) return;
      if (code === 42) {
        this.onQuit();
        return;
      }
      if (code) this.log.warn("Tray helper exited", { code });
      if (!this.stopping) this.restartTimer = setTimeout(() => this.start(), 1000);
    });
  }

  stop(): void {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.process?.kill();
    this.process = undefined;
  }
}
