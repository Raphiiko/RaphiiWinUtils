import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import {
  findLastInstanceIdInLog,
  findMostRecentVrChatLog,
  toVrChatLaunchUrl,
  VrChatRecoveryService,
  type VrChatRecoveryDependencies
} from "./vrChatRecoveryService.ts";

void test("recovers VRChat into the last logged instance after restarting SteamVR", async () => {
  const calls: string[] = [];
  const service = new VrChatRecoveryService(defaultConfig.vrChatRecovery, new Logger("test"), {
    findLastInstanceId: () => {
      calls.push("find-last-instance");
      return Promise.resolve("wrld_12345678-1234-1234-1234-123456789abc:42~region(eu)");
    },
    getRunningProcessNames: (names) => {
      calls.push(`probe:${names[0]}`);
      return Promise.resolve(new Set([names[0].toLowerCase()]));
    },
    stopProcesses: (names) => {
      calls.push(`stop:${names[0]}`);
      return Promise.resolve();
    },
    launchSteamApp: (_steamPath, appId, args = []) => {
      calls.push(`launch:${appId}:${args.join(",")}`);
      return Promise.resolve();
    },
    sleep: (ms) => {
      calls.push(`sleep:${ms}`);
      return Promise.resolve();
    }
  });

  assert.deepEqual(await service.recoverLastInstance(), { accepted: true });
  assert.deepEqual(calls, [
    "find-last-instance",
    "probe:vrchat",
    "stop:VRChat",
    "sleep:3000",
    "probe:vrmonitor",
    "stop:vrmonitor",
    "sleep:5000",
    "launch:250820:",
    "probe:OyasumiVR",
    "sleep:5000",
    "launch:438100:vrchat://launch?ref=vrchat.com&id=wrld_12345678-1234-1234-1234-123456789abc:42~region(eu)"
  ]);
});

void test("starts OyasumiVR alongside SteamVR when it is not already running", async () => {
  const calls: string[] = [];
  const service = new VrChatRecoveryService(defaultConfig.vrChatRecovery, new Logger("test"), {
    findLastInstanceId: () => Promise.resolve(undefined),
    getRunningProcessNames: (names) => {
      calls.push(`probe:${names[0]}`);
      return Promise.resolve(new Set());
    },
    stopProcesses: async () => {},
    launchSteamApp: (_steamPath, appId, args = []) => {
      calls.push(`launch:${appId}:${args.join(",")}`);
      return Promise.resolve();
    },
    sleep: (ms) => {
      calls.push(`sleep:${ms}`);
      return Promise.resolve();
    }
  });

  assert.deepEqual(await service.startVrChat(), { accepted: true });
  assert.deepEqual(calls, [
    "probe:vrchat",
    "probe:vrmonitor",
    "launch:250820:",
    "probe:OyasumiVR",
    "launch:2538150:",
    "sleep:5000",
    "launch:438100:"
  ]);
});

void test("rejects a second VRChat action while the first is still running", async () => {
  let releaseFirstAction: (() => void) | undefined;
  const waitForFirstAction = new Promise<void>((resolve) => {
    releaseFirstAction = resolve;
  });
  const dependencies: VrChatRecoveryDependencies = {
    findLastInstanceId: async () => {
      await waitForFirstAction;
      return undefined;
    },
    getRunningProcessNames: () => Promise.resolve(new Set()),
    stopProcesses: async () => {},
    launchSteamApp: async () => {},
    sleep: async () => {}
  };
  const service = new VrChatRecoveryService(
    defaultConfig.vrChatRecovery,
    new Logger("test"),
    dependencies
  );

  const firstAction = service.recoverLastInstance();
  assert.deepEqual(await service.startVrChat(), { accepted: false });
  releaseFirstAction?.();
  assert.deepEqual(await firstAction, { accepted: true });
});

void test("uses the final joined world instance from a VRChat log", () => {
  const instanceId = findLastInstanceIdInLog(`
    2026.07.18 Log - [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:old~region(us)
    2026.07.18 Log - [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:new~region(eu)
    2026.07.18 Log - [Analytics] Previous world wrld_33333333-3333-3333-3333-333333333333:not-a-join
  `);

  assert.equal(instanceId, "wrld_22222222-2222-2222-2222-222222222222:new~region(eu)");
  assert.equal(
    toVrChatLaunchUrl(instanceId),
    "vrchat://launch?ref=vrchat.com&id=wrld_22222222-2222-2222-2222-222222222222:new~region(eu)"
  );
});

void test("selects the most recently modified VRChat log", () => {
  assert.deepEqual(
    findMostRecentVrChatLog([
      { path: "output_log_2026-07-18_20-00-00.txt", modifiedAtMs: 100 },
      { path: "output_log_2026-07-18_19-00-00.txt", modifiedAtMs: 200 }
    ]),
    { path: "output_log_2026-07-18_19-00-00.txt", modifiedAtMs: 200 }
  );
});
