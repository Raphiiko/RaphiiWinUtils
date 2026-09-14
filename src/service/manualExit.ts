import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uptime } from "node:os";

export function manualExitPath(): string {
  return join(process.env.APPDATA ?? ".", "RaphiiWinUtils", "manual-exit.json");
}

export function recordManualExit(path = manualExitPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Date.now()));
}

export function shouldStayExited(
  manual: boolean,
  path = manualExitPath(),
  bootTime = Date.now() - uptime() * 1000
): boolean {
  if (!existsSync(path)) return false;
  if (!manual && Number(JSON.parse(readFileSync(path, "utf8"))) > bootTime) return true;
  rmSync(path, { force: true });
  return false;
}
