import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordManualExit, shouldStayExited } from "./manualExit.ts";

void test("Exit blocks the watchdog until a manual launch or reboot", () => {
  const directory = mkdtempSync(join(tmpdir(), "rwu-exit-"));
  const path = join(directory, "exit.json");
  try {
    assert.equal(shouldStayExited(false, path, 0), false);
    recordManualExit(path);
    assert.equal(shouldStayExited(false, path, 0), true);
    assert.equal(shouldStayExited(false, path, 0), true);
    assert.equal(shouldStayExited(true, path, 0), false);
    assert.equal(shouldStayExited(false, path, 0), false);
    recordManualExit(path);
    assert.equal(shouldStayExited(false, path, Date.now() + 1000), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
