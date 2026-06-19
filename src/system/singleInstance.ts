import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Logger } from "./logger.ts";

interface LockFile {
  pid: number;
  token: string;
  startedAt: string;
}

export interface SingleInstanceLock {
  release(): void;
}

export function acquireSingleInstanceLock(logger: Logger): SingleInstanceLock | undefined {
  const log = logger.child("single-instance");
  const lockPath = getLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(
          fd,
          `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
          "utf8"
        );
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          releaseLock(lockPath, token, log);
        }
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      const existing = readLockFile(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        log.warn("Another service instance is already running; exiting duplicate", {
          pid: existing.pid
        });
        return undefined;
      }

      log.warn("Removing stale single-instance lock", { lockPath, pid: existing?.pid });
      rmSync(lockPath, { force: true });
    }
  }

  throw new Error(`Could not acquire single-instance lock: ${lockPath}`);
}

function getLockPath(): string {
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
  return join(appData, "RaphiiWinUtils", "RaphiiWinUtils.lock");
}

function readLockFile(lockPath: string): LockFile | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
  } catch {
    return undefined;
  }
}

function releaseLock(lockPath: string, token: string, log: Logger): void {
  const existing = readLockFile(lockPath);
  if (!existing || existing.token !== token) return;

  try {
    rmSync(lockPath, { force: true });
  } catch (error) {
    log.warn("Could not remove single-instance lock", { error: String(error) });
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
