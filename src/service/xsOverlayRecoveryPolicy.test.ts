import assert from "node:assert/strict";
import test from "node:test";
import {
  createXsOverlayRecoveryState,
  observeXsOverlayProcesses,
  recordXsOverlayLaunch,
  type XsOverlayRecoveryConfig
} from "./xsOverlayRecoveryPolicy.ts";

const config: XsOverlayRecoveryConfig = {
  missingConfirmationMs: 3_000,
  launchGraceMs: 20_000,
  retryDelaysMs: [5_000],
  maxLaunchAttempts: 2,
  healthyResetMs: 60_000
};

void test("does not start XSOverlay when it was never seen in the SteamVR session", () => {
  const result = observeXsOverlayProcesses(
    createXsOverlayRecoveryState(),
    { steamVrRunning: true, xsOverlayRunning: false },
    config,
    1_000
  );

  assert.equal(result.action, "none");
  assert.equal(result.state.armed, false);
});

void test("restarts a confirmed XSOverlay crash once and then applies grace and backoff", () => {
  let state = createXsOverlayRecoveryState();
  state = observeXsOverlayProcesses(
    state,
    { steamVrRunning: true, xsOverlayRunning: true },
    config,
    0
  ).state;
  state = observeXsOverlayProcesses(
    state,
    { steamVrRunning: true, xsOverlayRunning: false },
    config,
    10_000
  ).state;

  const firstRestart = observeXsOverlayProcesses(
    state,
    { steamVrRunning: true, xsOverlayRunning: false },
    config,
    13_000
  );
  assert.equal(firstRestart.action, "launch");
  assert.equal(firstRestart.state.launchAttempts, 0);

  const firstLaunch = recordXsOverlayLaunch(firstRestart.state, config, 13_000);
  assert.equal(firstLaunch.launchAttempts, 1);

  const duringGrace = observeXsOverlayProcesses(
    firstLaunch,
    { steamVrRunning: true, xsOverlayRunning: false },
    config,
    37_999
  );
  assert.equal(duringGrace.action, "none");

  const secondRestart = observeXsOverlayProcesses(
    duringGrace.state,
    { steamVrRunning: true, xsOverlayRunning: false },
    config,
    38_000
  );
  assert.equal(secondRestart.action, "launch");
  assert.equal(recordXsOverlayLaunch(secondRestart.state, config, 38_000).launchAttempts, 2);
});

void test("resets the recovery session when SteamVR exits", () => {
  const armed = observeXsOverlayProcesses(
    createXsOverlayRecoveryState(),
    { steamVrRunning: true, xsOverlayRunning: true },
    config,
    0
  ).state;

  const result = observeXsOverlayProcesses(
    armed,
    { steamVrRunning: false, xsOverlayRunning: false },
    config,
    1_000
  );

  assert.equal(result.action, "none");
  assert.deepEqual(result.state, createXsOverlayRecoveryState());
});

void test("allows a fresh recovery budget after XSOverlay stays healthy", () => {
  const exhausted = {
    armed: true,
    launchAttempts: 2,
    healthySinceMs: 0,
    exhausted: true
  };

  const result = observeXsOverlayProcesses(
    exhausted,
    { steamVrRunning: true, xsOverlayRunning: true },
    config,
    60_000
  );

  assert.equal(result.state.launchAttempts, 0);
  assert.equal(result.state.exhausted, false);
});
