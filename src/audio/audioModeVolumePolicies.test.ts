import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config/schema.ts";
import { buildAudioModeVolumePolicies } from "./audioModeVolumePolicies.ts";

void test("caps every configured channel before switching output", () => {
  const policies = buildAudioModeVolumePolicies(
    defaultConfig,
    defaultConfig.audioModes.modes.headset
  );

  assert.deepEqual(
    policies.beforeOutputSwitch,
    defaultConfig.audio.channels.map((channel) => ({
      endpointNameContains: channel.endpointNameContains,
      volumePercent: 30,
      mode: "cap"
    }))
  );
  assert.deepEqual(policies.afterOutputSwitch, []);
});

void test("applies Beyond Game override only after switching output", () => {
  const policies = buildAudioModeVolumePolicies(
    defaultConfig,
    defaultConfig.audioModes.modes.beyond
  );

  assert.deepEqual(policies.afterOutputSwitch, [
    {
      endpointNameContains: "Game Audio",
      volumePercent: 100,
      mode: "set"
    }
  ]);
});

void test("rejects overrides for unknown channel names", () => {
  assert.throws(
    () =>
      buildAudioModeVolumePolicies(defaultConfig, {
        ...defaultConfig.audioModes.modes.headset,
        channelVolumeOverrides: { Unknown: 50 }
      }),
    /Unknown audio channel/
  );
});
