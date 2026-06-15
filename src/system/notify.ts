import { spawn } from "node:child_process";
import type { NotificationConfig } from "../config/schema";
import { Logger } from "./logger";

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

    const ps = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
      "$template = @\"",
      "<toast><visual><binding template=\"ToastGeneric\"><text>$($args[0])</text><text>$($args[1])</text></binding></visual></toast>",
      "\"@",
      "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
      "$xml.LoadXml($template)",
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${escapeForPowerShell(this.config.appName)}").Show($toast)`
    ].join("; ");

    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      ps,
      title,
      body
    ], {
      windowsHide: true,
      stdio: "ignore"
    });

    child.on("error", (error) => {
      this.log.warn("Failed to send notification", { error: String(error) });
    });
  }
}

function escapeForPowerShell(value: string): string {
  return value.replace(/"/g, "`\"");
}
