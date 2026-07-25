export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WallpaperAssignment {
  monitorId: string;
  /** Library file name, never a path. Presets stay valid when the library moves. */
  file: string;
  crop: CropRect;
}

export class InvalidWallpaperRequestError extends Error {}

const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".bmp"]);
const reservedNames = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const maxNameLength = 120;

/**
 * The only trust boundary in this module: names arrive over HTTP and become file paths under the
 * library directory. Allow-list rather than strip, so nothing clever survives.
 */
export function sanitizeLibraryName(name: unknown): string {
  if (typeof name !== "string")
    throw new InvalidWallpaperRequestError("File name must be a string");

  const base = name.replace(/^.*[\\/]/, "").trim();
  const dot = base.lastIndexOf(".");
  if (base.length === 0 || base.length > maxNameLength || dot <= 0) {
    throw new InvalidWallpaperRequestError(`Unsupported wallpaper file name: ${name}`);
  }
  if (!/^[A-Za-z0-9 ._-]+$/.test(base) || base.includes("..")) {
    throw new InvalidWallpaperRequestError(`Unsupported wallpaper file name: ${name}`);
  }
  if (!allowedExtensions.has(base.slice(dot).toLowerCase())) {
    throw new InvalidWallpaperRequestError(`Unsupported wallpaper file type: ${name}`);
  }
  if (reservedNames.test(base.slice(0, dot))) {
    throw new InvalidWallpaperRequestError(`Reserved Windows device name: ${name}`);
  }

  return base;
}

export function sanitizePresetName(name: unknown): string {
  if (typeof name !== "string")
    throw new InvalidWallpaperRequestError("Preset name must be a string");

  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > maxNameLength) {
    throw new InvalidWallpaperRequestError("Preset name must be 1-120 characters");
  }

  return trimmed;
}

export function parseAssignments(input: unknown): WallpaperAssignment[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new InvalidWallpaperRequestError("Expected a non-empty assignments array");
  }

  const seen = new Set<string>();
  return input.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const monitorId = record.monitorId;
    if (typeof monitorId !== "string" || monitorId.trim().length === 0) {
      throw new InvalidWallpaperRequestError("Each assignment needs a monitorId");
    }
    if (seen.has(monitorId)) {
      throw new InvalidWallpaperRequestError(`Duplicate assignment for monitor ${monitorId}`);
    }
    seen.add(monitorId);

    return {
      monitorId,
      file: sanitizeLibraryName(record.file),
      crop: parseCrop(record.crop)
    };
  });
}

function parseCrop(input: unknown): CropRect {
  const record = (input ?? {}) as Record<string, unknown>;
  const x = toInteger(record.x, "crop.x", 0);
  const y = toInteger(record.y, "crop.y", 0);
  const width = toInteger(record.width, "crop.width", 1);
  const height = toInteger(record.height, "crop.height", 1);
  return { x, y, width, height };
}

function toInteger(value: unknown, label: string, min: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new InvalidWallpaperRequestError(`${label} must be an integer >= ${min}`);
  }
  return parsed;
}

export function contentTypeFor(file: string): string {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".bmp") return "image/bmp";
  return "image/jpeg";
}
