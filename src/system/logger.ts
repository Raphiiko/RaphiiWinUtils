export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly minLevel: LogLevel = "info"
  ) {}

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
    if (level === "error" || level === "warn") process.stderr.write(output);
    else process.stdout.write(output);
  }
}
