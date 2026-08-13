import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pruneLogs } from "./logger.ts";

await describe("pruneLogs", async () => {
  await test("removes every log older than a week and keeps the rest", () => {
    const logDir = mkdtempSync(join(tmpdir(), "raphii-logs-"));
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 60 * 60;

    const stale = ["service-2026-08-01.log", "update-2026-08-01.log", "volume-fallback.log"];
    const fresh = ["service-2026-08-13.log", "update-2026-08-13.log"];

    for (const name of [...stale, ...fresh]) {
      writeFileSync(join(logDir, name), "line\n", "utf8");
    }
    for (const name of stale) {
      utimesSync(join(logDir, name), eightDaysAgo, eightDaysAgo);
    }
    writeFileSync(join(logDir, "config.json"), "{}", "utf8");
    utimesSync(join(logDir, "config.json"), eightDaysAgo, eightDaysAgo);

    try {
      pruneLogs(logDir);

      for (const name of stale) assert.equal(existsSync(join(logDir, name)), false, name);
      for (const name of fresh) assert.equal(existsSync(join(logDir, name)), true, name);
      assert.equal(existsSync(join(logDir, "config.json")), true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
