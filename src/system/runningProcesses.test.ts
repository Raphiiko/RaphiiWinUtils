import assert from "node:assert/strict";
import test from "node:test";
import { getRunningProcessNames, stopProcesses } from "./runningProcesses.ts";

void test("returns present processes when another requested process is absent", async () => {
  const processNames = await getRunningProcessNames(["node", "RaphiiWinUtilsDefinitelyMissing"]);

  assert.equal(processNames.has("node"), true);
  assert.equal(processNames.has("raphiiwinutilsdefinitelymissing"), false);
});

void test("does not fail when asked to stop a process that is already absent", async () => {
  await stopProcesses(["RaphiiWinUtilsDefinitelyMissing"]);
});
