import assert from "node:assert/strict";
import test from "node:test";
import { getRunningProcessNames } from "./runningProcesses.ts";

void test("returns present processes when another requested process is absent", async () => {
  const processNames = await getRunningProcessNames(["node", "RaphiiWinUtilsDefinitelyMissing"]);

  assert.equal(processNames.has("node"), true);
  assert.equal(processNames.has("raphiiwinutilsdefinitelymissing"), false);
});
