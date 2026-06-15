import { spawn } from "node:child_process";
import type { NotificationConfig } from "../config/schema";
import { Logger } from "./logger";
import { getSnoreToastPath } from "./paths";

export class Notifier {
  private readonly log: Logger;

  constructor(
    private readonly config: NotificationConfig,
    logger: Logger
  ) {
    this.log = logger.child("notify");
  }

  send(title: string, body: string): void {
    if (!this.config.enabled) return;

    const child = spawn(getSnoreToastPath(), [
      "-appID",
      "Raphiiko.RaphiiWinUtils",
      "-t",
      title,
      "-m",
      body,
      "-silent"
    ], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.log.warn("SnoreToast stderr", { message: chunk.toString("utf8").trim() });
    });

    child.on("error", (error) => {
      this.log.warn("Failed to send notification", { error: String(error) });
    });

    child.on("exit", (code) => {
      if (code === -1) this.log.warn("SnoreToast reported notification failure", { code });
    });
  }
}
