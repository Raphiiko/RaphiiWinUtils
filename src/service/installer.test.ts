import assert from "node:assert/strict";
import test from "node:test";
import { buildLogonTaskRegistrationScript } from "./installer.ts";

void test("registers a recurring watchdog trigger for the installed service", () => {
  const script = buildLogonTaskRegistrationScript(
    "C:\\Tools\\RaphiiWinUtils",
    "RaphiiWinUtils",
    "C:\\Tools\\RaphiiWinUtils\\RaphiiWinUtils.launch.vbs"
  );

  assert.match(script, /\$watchdogTrigger = New-ScheduledTaskTrigger -Once/);
  assert.match(script, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /-Trigger @\(\$trigger, \$watchdogTrigger\)/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
});
