import { existsSync, mkdirSync } from "node:fs";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Logger } from "../system/logger.ts";
import { getWallpaperHelperPath } from "../system/paths.ts";
import { runCommand } from "../system/process.ts";
import {
  InvalidWallpaperRequestError,
  parseAssignments,
  sanitizeLibraryName,
  sanitizePresetName,
  type WallpaperAssignment
} from "./wallpaperRequests.ts";

export interface MonitorInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** EDID friendly name. Several identical panels legitimately share one. */
  name: string;
  connector: string;
}

export interface LibraryEntry {
  file: string;
  sizeBytes: number;
  modifiedMs: number;
}

export interface ApplyResult {
  applied: { monitorId: string; path: string; reused: boolean; width: number; height: number }[];
  errors: { monitorId: string; error: string }[];
  skipped: string[];
}

export class WallpaperHelperError extends Error {}

const helperTimeoutMs = 120_000;

export class WallpaperService {
  private readonly log: Logger;
  private readonly root: string;
  private readonly libraryDir: string;
  private readonly cacheDir: string;
  private readonly presetsPath: string;
  private readonly hiddenPath: string;
  private readonly currentPath: string;

  constructor(logger: Logger) {
    this.log = logger.child("wallpaper");
    const appData =
      process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
    this.root = join(appData, "RaphiiWinUtils", "wallpapers");
    this.libraryDir = join(this.root, "library");
    this.cacheDir = join(this.root, "cache");
    this.presetsPath = join(this.root, "presets.json");
    this.hiddenPath = join(this.root, "hidden-monitors.json");
    this.currentPath = join(this.root, "current.json");
    mkdirSync(this.libraryDir, { recursive: true });
    mkdirSync(this.cacheDir, { recursive: true });
  }

  libraryPath(file: string): string {
    return join(this.libraryDir, sanitizeLibraryName(file));
  }

  async listMonitors(): Promise<MonitorInfo[]> {
    const payload = await this.runHelper(["monitors"]);
    return (payload as { monitors?: MonitorInfo[] }).monitors ?? [];
  }

  /**
   * Monitors the user never wants to target. Windows reports daisy-chained duplicates as fully
   * active displays with their own desktop area, so there is nothing to detect — only to remember.
   */
  async listHidden(): Promise<string[]> {
    if (!existsSync(this.hiddenPath)) return [];

    try {
      const raw = JSON.parse(await readFile(this.hiddenPath, "utf8")) as unknown;
      return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
    } catch (error) {
      this.log.warn("Ignoring unreadable hidden monitor list", { error: String(error) });
      return [];
    }
  }

  async setHidden(input: unknown): Promise<string[]> {
    if (!Array.isArray(input) || input.some((id) => typeof id !== "string")) {
      throw new InvalidWallpaperRequestError("Expected an array of monitor ids");
    }

    const ids = [...new Set(input as string[])];
    await this.writeAtomic(this.hiddenPath, Buffer.from(`${JSON.stringify(ids, null, 2)}\n`));
    this.log.info("Hidden monitor list updated", { hidden: ids.length });
    return ids;
  }

  async listLibrary(): Promise<LibraryEntry[]> {
    const entries = await readdir(this.libraryDir, { withFileTypes: true });
    const files: LibraryEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        sanitizeLibraryName(entry.name);
      } catch {
        continue;
      }
      const stats = await stat(join(this.libraryDir, entry.name));
      files.push({ file: entry.name, sizeBytes: stats.size, modifiedMs: stats.mtimeMs });
    }
    return files.sort((left, right) => left.file.localeCompare(right.file));
  }

  async addImage(name: unknown, bytes: Buffer): Promise<LibraryEntry> {
    if (bytes.byteLength === 0) throw new InvalidWallpaperRequestError("Uploaded file was empty");

    const file = sanitizeLibraryName(name);
    await this.writeAtomic(join(this.libraryDir, file), bytes);
    this.log.info("Wallpaper added to library", { file, sizeBytes: bytes.byteLength });
    return { file, sizeBytes: bytes.byteLength, modifiedMs: Date.now() };
  }

  /**
   * What apply last put on the desktop. The dashboard opens on this so a refresh shows the live
   * configuration instead of an empty page.
   */
  async listCurrent(): Promise<WallpaperAssignment[]> {
    if (!existsSync(this.currentPath)) return [];

    try {
      return parseAssignments(JSON.parse(await readFile(this.currentPath, "utf8")));
    } catch (error) {
      this.log.warn("Ignoring unreadable current wallpaper state", { error: String(error) });
      return [];
    }
  }

  async listPresets(): Promise<Record<string, WallpaperAssignment[]>> {
    if (!existsSync(this.presetsPath)) return {};

    try {
      const raw = JSON.parse(await readFile(this.presetsPath, "utf8")) as Record<string, unknown>;
      const presets: Record<string, WallpaperAssignment[]> = {};
      for (const [name, assignments] of Object.entries(raw)) {
        try {
          presets[sanitizePresetName(name)] = parseAssignments(assignments);
        } catch (error) {
          this.log.warn("Dropping invalid wallpaper preset", { name, error: String(error) });
        }
      }
      return presets;
    } catch (error) {
      // A half-written or hand-edited file must not take the dashboard down.
      this.log.warn("Ignoring unreadable wallpaper presets file", { error: String(error) });
      return {};
    }
  }

  async savePreset(name: unknown, assignments: unknown): Promise<string> {
    const presetName = sanitizePresetName(name);
    const parsed = parseAssignments(assignments);
    const presets = await this.listPresets();
    presets[presetName] = parsed;
    await this.writeAtomic(this.presetsPath, Buffer.from(`${JSON.stringify(presets, null, 2)}\n`));
    this.log.info("Wallpaper preset saved", { preset: presetName, monitors: parsed.length });
    return presetName;
  }

  async apply(assignments: unknown): Promise<ApplyResult> {
    const requested = parseAssignments(assignments);
    const hidden = new Set(await this.listHidden());
    const parsed = requested.filter((assignment) => !hidden.has(assignment.monitorId));
    const skipped = requested
      .filter((assignment) => hidden.has(assignment.monitorId))
      .map((assignment) => assignment.monitorId);
    if (parsed.length === 0) {
      throw new InvalidWallpaperRequestError("Every assignment targets a hidden monitor");
    }

    for (const assignment of parsed) {
      const path = this.libraryPath(assignment.file);
      if (!existsSync(path)) {
        throw new InvalidWallpaperRequestError(`Library file not found: ${assignment.file}`);
      }
    }

    const plan = {
      cacheDir: this.cacheDir,
      assignments: parsed.map((assignment) => ({
        monitorId: assignment.monitorId,
        source: this.libraryPath(assignment.file),
        crop: assignment.crop
      }))
    };

    const payload = (await this.runHelper(["apply"], JSON.stringify(plan))) as Partial<ApplyResult>;
    const result: ApplyResult = {
      applied: payload.applied ?? [],
      errors: payload.errors ?? [],
      skipped
    };
    // Remember only what actually landed, so a reload never shows a monitor as set when its apply
    // failed.
    const appliedIds = new Set(result.applied.map((entry) => entry.monitorId));
    const landed = parsed.filter((assignment) => appliedIds.has(assignment.monitorId));
    if (landed.length > 0) {
      await this.writeAtomic(this.currentPath, Buffer.from(`${JSON.stringify(landed, null, 2)}\n`));
    }

    this.log.info("Wallpapers applied", {
      applied: result.applied.length,
      reused: result.applied.filter((entry) => entry.reused).length,
      skipped: skipped.length,
      errors: result.errors
    });
    return result;
  }

  private async writeAtomic(path: string, bytes: Buffer): Promise<void> {
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, bytes);
    await rename(tempPath, path);
  }

  private async runHelper(args: string[], input?: string): Promise<unknown> {
    const helperPath = getWallpaperHelperPath();
    if (!existsSync(helperPath)) {
      throw new WallpaperHelperError(`Wallpaper helper not found: ${helperPath}`);
    }

    const result = await runCommand(helperPath, args, { timeoutMs: helperTimeoutMs, input });
    const stdout = result.stdout.trim();
    let payload: unknown;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new WallpaperHelperError(
        `Wallpaper helper returned no JSON (exit ${result.code}): ${result.stderr.trim() || stdout}`
      );
    }

    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") throw new WallpaperHelperError(error);
    if (result.code !== 0) {
      throw new WallpaperHelperError(`Wallpaper helper failed with exit ${result.code}`);
    }

    return payload;
  }
}
