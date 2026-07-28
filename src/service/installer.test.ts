import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLogonTaskRegistrationScript,
  buildPushUpdateWatcherScript,
  buildVrCleanupTaskRegistrationScript
} from "./installer.ts";

void test("registers a recurring watchdog trigger for the installed service", () => {
  const script = buildLogonTaskRegistrationScript(
    "C:\\Tools\\RaphiiWinUtils",
    "RaphiiWinUtils",
    "C:\\Tools\\RaphiiWinUtils\\RaphiiWinUtils.launch.vbs"
  );

  assert.match(script, /\$watchdogTrigger = New-ScheduledTaskTrigger -Daily -At '00:00'/);
  assert.match(script, /\$watchdogRepetition = New-ScheduledTaskTrigger -Once/);
  assert.match(script, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /-Trigger @\(\$trigger, \$watchdogTrigger\)/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.doesNotMatch(script, /RunLevel Highest/);
});

void test("registers a fixed-purpose elevated VR cleanup task", () => {
  const script = buildVrCleanupTaskRegistrationScript();

  assert.match(script, /RaphiiWinUtils VR Cleanup/);
  assert.match(script, /taskkill\.exe/);
  assert.match(script, /RunLevel Highest/);
  assert.doesNotMatch(script, /steam\.exe/i);
});

void test("waits for git push to finish before requesting one update check", () => {
  const script = buildPushUpdateWatcherScript("http://127.0.0.1:17642/update/check");

  assert.match(script, /Wait-Process -Id \$GitPushPid/);
  assert.match(script, /Start-Sleep -Seconds 3/);
  assert.match(script, /Invoke-RestMethod -Method Post/);
});
