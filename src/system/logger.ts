import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

export class Logger {
  private readonly logDir: string;

  constructor(
    private readonly scope: string,
    private readonly minLevel: LogLevel = "info"
  ) {
    const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
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

function appendBoundedLog(logDir: string, output: string): void {
  const logFilePath = join(logDir, `service-${formatDate(new Date())}.log`);
  if (existsSync(logFilePath) && statSync(logFilePath).size > maxLogFileBytes) {
    writeFileSync(logFilePath, [
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        scope: "logger",
        message: "Log file exceeded size cap; truncated current daily log"
      }),
      output.trimEnd()
    ].join("\n") + "\n", "utf8");
    return;
  }

  appendFileSync(logFilePath, output, "utf8");
}

function pruneLogs(logDir: string): void {
  const now = Date.now();
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^service-\d{4}-\d{2}-\d{2}\.log$/i.test(entry.name) && entry.name !== "service.log") continue;

    const path = join(logDir, entry.name);
    const stats = statSync(path);
    if (now - stats.mtimeMs > maxLogAgeMs || entry.name === "service.log") {
      rmSync(path, { force: true });
    }
  }
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
