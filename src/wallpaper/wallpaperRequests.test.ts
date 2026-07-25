import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidWallpaperRequestError,
  parseAssignments,
  sanitizeLibraryName,
  sanitizePresetName
} from "./wallpaperRequests.ts";

void test("accepts plain image file names", () => {
  assert.equal(sanitizeLibraryName("Sunset 01.jpg"), "Sunset 01.jpg");
  assert.equal(sanitizeLibraryName("  a_b-c.PNG  "), "a_b-c.PNG");
});

void test("rejects names that could escape the library directory", () => {
  for (const name of [
    "../../config.json",
    "..\\config.json",
    "C:\\Windows\\win.ini",
    "no-extension",
    ".png",
    "wall.exe",
    "con.png",
    'quote".png',
    `${"x".repeat(200)}.png`,
    42
  ]) {
    assert.throws(
      () => sanitizeLibraryName(name),
      InvalidWallpaperRequestError,
      `expected ${String(name)} to be rejected`
    );
  }
});

void test("strips a leading directory instead of trusting the browser file name", () => {
  assert.equal(sanitizeLibraryName("C:/Users/me/Pictures/wall.png"), "wall.png");
});

void test("parses assignments and coerces crop values to integers", () => {
  const parsed = parseAssignments([
    { monitorId: "MON1", file: "a.png", crop: { x: 10.4, y: 0, width: 1920.6, height: 1080 } }
  ]);
  assert.deepEqual(parsed, [
    { monitorId: "MON1", file: "a.png", crop: { x: 10, y: 0, width: 1921, height: 1080 } }
  ]);
});

void test("rejects malformed assignment payloads", () => {
  for (const payload of [
    [],
    "nope",
    [{ file: "a.png", crop: { x: 0, y: 0, width: 1, height: 1 } }],
    [{ monitorId: "MON1", file: "a.png", crop: { x: -1, y: 0, width: 1, height: 1 } }],
    [{ monitorId: "MON1", file: "a.png", crop: { x: 0, y: 0, width: 0, height: 1 } }],
    [{ monitorId: "MON1", file: "a.png", crop: { x: 0, y: 0, width: "wide", height: 1 } }],
    [
      { monitorId: "MON1", file: "a.png", crop: { x: 0, y: 0, width: 1, height: 1 } },
      { monitorId: "MON1", file: "b.png", crop: { x: 0, y: 0, width: 1, height: 1 } }
    ]
  ]) {
    assert.throws(() => parseAssignments(payload), InvalidWallpaperRequestError);
  }
});

void test("trims preset names and rejects empty ones", () => {
  assert.equal(sanitizePresetName("  Night  "), "Night");
  assert.throws(() => sanitizePresetName("   "), InvalidWallpaperRequestError);
});
