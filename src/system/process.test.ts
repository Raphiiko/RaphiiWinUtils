import assert from "node:assert/strict";
import test from "node:test";
import { launchDetached } from "./process.ts";

// The whole point of launchDetached: resolve once the process spawns, WITHOUT
// waiting for it to exit (steam.exe stays resident and never would). A resident
// child must still resolve promptly.
void test("resolves on spawn without waiting for the process to exit", async () => {
  const longLived =
    process.platform === "win32"
      ? { cmd: "ping", args: ["-n", "30", "127.0.0.1"] }
      : { cmd: "sleep", args: ["30"] };

  const started = Date.now();
  await launchDetached(longLived.cmd, longLived.args);
  assert.ok(Date.now() - started < 5_000, "should resolve well before the child exits");
});

void test("rejects when the command cannot be spawned", async () => {
  await assert.rejects(launchDetached("RaphiiWinUtilsDefinitelyMissing.exe", []));
});
