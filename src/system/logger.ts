import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const maxLogAgeMs = 7 * 24 * 60 * 60 * 1000;
const maxLogFileBytes = 10 * 1024 * 1024;
let consoleErrorHandlersAttached = false;
let prunedForDate = "";

export class Logger {
  private readonly logDir: string;
  private readonly scope: string;
  private readonly minLevel: LogLevel;

  constructor(scope: string, minLevel: LogLevel = "info") {
    attachConsoleErrorHandlers();
    this.scope = scope;
    this.minLevel = minLevel;
    const appData =
      process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
    this.logDir = join(appData, "RaphiiWinUtils", "logs");
    mkdirSync(this.logDir, { recursive: true });
    pruneLogs(this.logDir);
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.minLevel);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (order[level] < order[this.minLevel]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(meta === undefined ? {} : { meta })
    };
    const output = `${JSON.stringify(line)}\n`;
    try {
      appendBoundedLog(this.logDir, output);
    } catch {
      // Keep logging non-fatal. Console output may still be available in dev.
    }

    if (level === "error" || level === "warn") process.stderr.write(output);
    else process.stdout.write(output);
  }
}

function attachConsoleErrorHandlers(): void {
  if (consoleErrorHandlersAttached) return;
  consoleErrorHandlersAttached = true;

  // The background task has no durable console. Writing a log line after its
  // host closes the pipe must not terminate the service and take MQTT offline.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
}

function appendBoundedLog(logDir: string, output: string): void {
  const date = formatDate(new Date());
  // The service runs for weeks without a restart, so the constructor prune alone
  // would never reclaim anything. Every rollover into a new daily file prunes again.
  if (date !== prunedForDate) {
    prunedForDate = date;
    try {
      pruneLogs(logDir);
    } catch {
      // A failed prune must not drop the log line that triggered it.
    }
  }

  const logFilePath = join(logDir, `service-${date}.log`);
  if (existsSync(logFilePath) && statSync(logFilePath).size > maxLogFileBytes) {
    writeFileSync(
      logFilePath,
      [
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          scope: "logger",
          message: "Log file exceeded size cap; truncated current daily log"
        }),
        output.trimEnd()
      ].join("\n") + "\n",
      "utf8"
    );
    return;
  }

  appendFileSync(logFilePath, output, "utf8");
}

export function pruneLogs(logDir: string): void {
  const now = Date.now();
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".log")) continue;

    const path = join(logDir, entry.name);
    if (now - statSync(path).mtimeMs > maxLogAgeMs) rmSync(path, { force: true });
  }
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
