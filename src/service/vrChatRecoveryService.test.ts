import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import {
  findLastInstanceIdInLog,
  findMostRecentVrChatLog,
  toVrChatLaunchUrl,
  VrChatRecoveryService,
  type VrChatRecoveryDependencies,
  type VrRecoveryStatus
} from "./vrChatRecoveryService.ts";

void test("soft recovery serializes VR stack launch and restores the last instance", async () => {
  const events: string[] = [];
  const service = new VrChatRecoveryService(testConfig(), new Logger("test"), dependencies(events));
  const phases: string[] = [];
  service.onStatusChange((status) => phases.push(status.phase));

  assert.deepEqual(await service.recoverLastInstance(), {
    accepted: true,
    operationId: "operation-1"
  });
  assert.deepEqual(events, [
    "find-instance",
    "stop:VRChat,OyasumiVR,vrmonitor,vrserver",
    "sleep:5000",
    "probe:steam",
    "probe:steam",
    "launch:250820",
    "probe:vrmonitor",
    "probe:vrserver",
    "probe:oyasumivr",
    "launch:438100:vrchat://launch?ref=vrchat.com&id=wrld_12345678-1234-1234-1234-123456789abc:42~region(eu)",
    "probe:vrchat"
  ]);
  assert.ok(phases.includes("stopping-vr-stack"));
  assert.deepEqual(service.getStatus().completedPhases, [
    "soft-recovering",
    "stopping-vr-stack",
    "waiting-for-steam",
    "waiting-for-steamvr",
    "waiting-for-oyasumi",
    "launching-vrchat",
    "verifying-rejoin"
  ]);
});

void test("merges correlated Home Assistant steps into the authoritative recovery history", async () => {
  const events: string[] = [];
  const service = new VrChatRecoveryService(testConfig(), new Logger("test"), dependencies(events));

  assert.deepEqual(await service.prepare("soft-recover", "panel-1"), {
    accepted: true,
    operationId: "panel-1"
  });
  assert.equal(events.length, 0);
  assert.equal(
    (await service.reportExternalPhase("stale", "setting-audio-mode", "active")).accepted,
    false
  );
  await service.reportExternalPhase("panel-1", "setting-audio-mode", "active");
  await service.reportExternalPhase("panel-1", "setting-audio-mode", "completed");
  await service.reportExternalPhase("panel-1", "setting-audio-mode", "active");
  assert.equal(service.getStatus().activePhases?.includes("setting-audio-mode"), false);
  await service.reportExternalPhase("panel-1", "turning-lighthouses-off", "active");
  await service.reportExternalPhase("panel-1", "turning-lighthouses-off", "completed");
  assert.equal((await service.recoverLastInstance("panel-1")).accepted, true);
  assert.deepEqual(service.getStatus().completedPhases?.slice(0, 3), [
    "soft-recovering",
    "setting-audio-mode",
    "turning-lighthouses-off"
  ]);
});

void test("prepared recovery survives restart and still requires the matching action", async () => {
  const events: string[] = [];
  let prepared: VrRecoveryStatus | undefined;
  const first = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies([], {
      saveStatus: (status) => {
        prepared = structuredClone(status);
        return Promise.resolve();
      }
    })
  );
  await first.prepare("start", "panel-1");
  assert.equal((await first.prepare("soft-recover", "panel-1")).accepted, false);
  const preparedSnapshot = structuredClone(prepared);
  await first.cancel("panel-1");

  const second = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, { loadStatus: () => Promise.resolve(preparedSnapshot) })
  );
  await second.start();
  assert.equal((await second.startVrChat("panel-1")).accepted, true);
  assert.equal(events.includes("launch:438100"), true);
});

void test("does not reserve a disabled recovery", async () => {
  const config = testConfig();
  config.vrChatRecovery.enabled = false;
  const service = new VrChatRecoveryService(config, new Logger("test"), dependencies([]));

  assert.equal((await service.prepare("start", "panel-1")).accepted, false);
  assert.equal(service.getStatus().phase, "idle");
});

void test("deduplicates a correlated command while prepared state is being saved", async () => {
  const events: string[] = [];
  let blockPreparedClear = false;
  let releaseSave = () => {};
  const saveBlocked = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const service = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, {
      saveStatus: (status) =>
        blockPreparedClear && status.prepared === false ? saveBlocked : Promise.resolve()
    })
  );
  await service.prepare("start", "panel-1");
  blockPreparedClear = true;

  const first = service.startVrChat("panel-1");
  const duplicate = await service.startVrChat("panel-1");
  assert.equal(duplicate.accepted, true);
  releaseSave();
  assert.equal((await first).accepted, true);
  assert.equal(events.filter((event) => event === "launch:438100").length, 1);
});

void test("start waits for each VR stack dependency before launching its dependent", async () => {
  const events: string[] = [];
  const running = new Set<string>();
  let oyasumiLaunchRequested = false;
  let oyasumiReadinessChecks = 0;
  const service = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, {
      getRunningProcessNames: (names) => {
        events.push(`probe:${names.join(",").toLowerCase()}`);
        if (names[0]?.toLowerCase() === "oyasumivr" && oyasumiLaunchRequested) {
          oyasumiReadinessChecks += 1;
          if (oyasumiReadinessChecks >= 2) running.add("oyasumivr");
        }
        return Promise.resolve(new Set(names.filter((name) => running.has(name.toLowerCase()))));
      },
      launchSteamClient: () => {
        events.push("launch-steam");
        running.add("steam");
        return Promise.resolve();
      },
      launchSteamApp: (_path, appId, args = []) => {
        events.push(`launch:${appId}${args.length ? `:${args.join(",")}` : ""}`);
        if (appId === "250820") {
          running.add("vrmonitor");
          running.add("vrserver");
        }
        if (appId === "2538150") oyasumiLaunchRequested = true;
        if (appId === "438100") running.add("vrchat");
        return Promise.resolve();
      }
    })
  );
  const statuses: VrRecoveryStatus[] = [];
  service.onStatusChange((status) => statuses.push(structuredClone(status)));

  assert.deepEqual(await service.startVrChat(), { accepted: true, operationId: "operation-1" });
  const steamVrReady = events.indexOf("probe:vrserver");
  assert.ok(steamVrReady > events.indexOf("launch:250820"));
  assert.ok(events.indexOf("launch:2538150") > steamVrReady);
  assert.ok(events.indexOf("launch:438100") > steamVrReady);
  assert.ok(events.includes("probe:vrchat"));
  assert.ok(
    statuses.some(
      (status) =>
        status.activePhases?.includes("waiting-for-oyasumi") &&
        status.activePhases.includes("launching-vrchat")
    )
  );
});

void test("start launches VRChat after SteamVR even when OyasumiVR never becomes ready", async () => {
  const events: string[] = [];
  const running = new Set<string>();
  const config = testConfig();
  config.vrStackStartup.oyasumiReadyTimeoutMs = 0;
  const service = new VrChatRecoveryService(
    config,
    new Logger("test"),
    dependencies(events, {
      getRunningProcessNames: (names) =>
        Promise.resolve(new Set(names.filter((name) => running.has(name.toLowerCase())))),
      launchSteamClient: () => {
        running.add("steam");
        return Promise.resolve();
      },
      launchSteamApp: (_path, appId) => {
        events.push(`launch:${appId}`);
        if (appId === "250820") {
          running.add("vrmonitor");
          running.add("vrserver");
        }
        if (appId === "438100") running.add("vrchat");
        return Promise.resolve();
      }
    })
  );

  assert.equal((await service.startVrChat()).accepted, false);
  assert.equal(events.includes("launch:2538150"), true);
  assert.equal(events.includes("launch:438100"), true);
  assert.equal(service.getStatus().completedPhases?.includes("waiting-for-oyasumi"), false);
});

void test("start retries when Steam drops the first VRChat launch command", async () => {
  const events: string[] = [];
  const running = new Set(["steam", "vrmonitor", "vrserver", "oyasumivr"]);
  let vrChatLaunches = 0;
  const config = testConfig();
  config.vrStackStartup.maxLaunchAttempts = 2;
  config.vrStackStartup.vrChatJoinTimeoutMs = 0;
  const service = new VrChatRecoveryService(
    config,
    new Logger("test"),
    dependencies(events, {
      getRunningProcessNames: (names) =>
        Promise.resolve(new Set(names.filter((name) => running.has(name.toLowerCase())))),
      launchSteamApp: (_path, appId) => {
        events.push(`launch:${appId}`);
        if (appId === "438100" && ++vrChatLaunches === 2) running.add("vrchat");
        return Promise.resolve();
      }
    })
  );

  assert.equal((await service.startVrChat()).accepted, true);
  assert.equal(vrChatLaunches, 2);
  assert.equal(service.getStatus().phase, "completed");
});

void test("local recovery replaces a stale hard recovery journal", async () => {
  const events: string[] = [];
  const saved: VrRecoveryStatus[] = [];
  const service = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, {
      loadStatus: () =>
        Promise.resolve({
          operationId: "old-hard-recovery",
          action: "hard-recover",
          phase: "failed-needs-attention",
          updatedAt: new Date(0).toISOString(),
          reason: "old failure"
        }),
      saveStatus: (status) => {
        saved.push(structuredClone(status));
        return Promise.resolve();
      }
    })
  );

  await service.start();
  assert.equal((await service.recoverLastInstance()).accepted, true);
  assert.equal(saved.at(-1)?.action, "soft-recover");
  assert.equal(saved.at(-1)?.phase, "completed");
});

void test("a local recovery cannot replace a pending hard recovery", async () => {
  const events: string[] = [];
  let saved: VrRecoveryStatus | undefined;
  const first = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, {
      requestReboot: () => {
        events.push("reboot");
        return Promise.resolve();
      },
      saveStatus: (status) => {
        saved = structuredClone(status);
        return Promise.resolve();
      }
    })
  );

  const request = await first.hardRecover();
  assert.equal(request.accepted, true);
  await waitFor(() => first.getStatus().phase === "reboot-commanded");
  const start = await first.startVrChat();
  assert.equal(start.accepted, false);
  assert.match(start.reason ?? "", /already active/);
  assert.equal(saved?.action, "hard-recover");
  assert.equal(saved?.phase, "reboot-commanded");
  assert.equal(events.includes("reboot"), true);
  assert.equal(events.includes("launch:250820"), false);
  await first.cancel(request.operationId);
});

void test("hard recovery does not reboot when its journal cannot be saved", async () => {
  const events: string[] = [];
  const service = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, {
      saveStatus: () => Promise.reject(new Error("disk full"))
    })
  );

  assert.equal((await service.hardRecover()).accepted, true);
  await waitFor(() => service.getStatus().phase === "failed-needs-attention");
  assert.match(service.getStatus().reason ?? "", /disk full/);
  assert.equal(events.includes("reboot"), false);
});

void test("journal failure aborts parallel startup without reviving the operation", async () => {
  const events: string[] = [];
  const service = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, {
      saveStatus: (status) => status.phase === "launching-vrchat"
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve()
    })
  );

  assert.equal((await service.startVrChat()).accepted, false);
  assert.equal(service.getStatus().phase, "failed-needs-attention");
  assert.match(service.getStatus().reason ?? "", /disk full/);
  assert.equal(events.some((event) => event.startsWith("launch:438100")), false);
});

void test("journal failure is the final persisted parallel startup state", async () => {
  const events: string[] = [];
  const saved: VrRecoveryStatus[] = [];
  let failed = false;
  const service = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, {
      saveStatus: (status) => {
        if (!failed && status.phase === "waiting-for-oyasumi") {
          failed = true;
          return Promise.reject(new Error("disk full"));
        }
        saved.push(structuredClone(status));
        return Promise.resolve();
      }
    })
  );

  assert.equal((await service.startVrChat()).accepted, false);
  assert.equal(saved.at(-1)?.phase, "failed-needs-attention");
});

void test("hard recovery remains resumable after another service start", async () => {
  const events: string[] = [];
  const service = new VrChatRecoveryService(
    testConfig(),
    new Logger("test"),
    dependencies(events, {
      loadStatus: () => Promise.resolve({
        operationId: "hard-1",
        action: "hard-recover",
        phase: "awaiting-rwu-after-boot",
        updatedAt: new Date(0).toISOString()
      })
    })
  );

  await service.start();
  assert.equal(service.getStatus().phase, "awaiting-rwu-after-boot");
  assert.equal((await service.resumeHardRecovery("hard-1")).accepted, true);
  await waitFor(() => service.getStatus().phase === "completed-with-warning");
  assert.deepEqual(service.getStatus().completedPhases?.slice(0, 4), [
    "preparing",
    "stopping-vr-stack",
    "reboot-commanded",
    "awaiting-rwu-after-boot"
  ]);
  assert.equal(events.includes("matrix"), true);
});

void test("uses the final joined world instance from a VRChat log", () => {
  const instanceId = findLastInstanceIdInLog(`
    [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:old~region(us)
    [Behaviour] Joining or Creating Room: wrld_22222222-2222-2222-2222-222222222222:new~region(eu)
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
      { path: "old", modifiedAtMs: 10 },
      { path: "new", modifiedAtMs: 20 }
    ]),
    { path: "new", modifiedAtMs: 20 }
  );
});

function testConfig() {
  return {
    ...structuredClone(defaultConfig),
    hardRecovery: {
      ...defaultConfig.hardRecovery,
      desktopSettleMs: 0,
      matrixReadyTimeoutMs: 10,
      matrixReadyRetryDelayMs: 0
    },
    vrStackStartup: {
      ...defaultConfig.vrStackStartup,
      steamReadyTimeoutMs: 10,
      steamVrReadyTimeoutMs: 10,
      oyasumiReadyTimeoutMs: 10,
      vrChatJoinTimeoutMs: 10,
      retryDelayMs: 0,
      maxLaunchAttempts: 1
    }
  };
}

function dependencies(
  events: string[],
  overrides: Partial<VrChatRecoveryDependencies> = {}
): Partial<VrChatRecoveryDependencies> {
  const instanceId = "wrld_12345678-1234-1234-1234-123456789abc:42~region(eu)";
  let operation = 0;
  return {
    findLastInstanceId: () => {
      events.push("find-instance");
      return Promise.resolve(instanceId);
    },
    getRunningProcessNames: (names) => {
      events.push(`probe:${names[0]?.toLowerCase()}`);
      return Promise.resolve(new Set(names.map((name) => name.toLowerCase())));
    },
    stopProcesses: (names) => {
      events.push(`stop:${names.join(",")}`);
      return Promise.resolve();
    },
    launchSteamClient: () => {
      events.push("launch-steam");
      return Promise.resolve();
    },
    launchSteamApp: (_path, appId, args = []) => {
      events.push(`launch:${appId}${args.length ? `:${args.join(",")}` : ""}`);
      return Promise.resolve();
    },
    isMatrixReady: () => {
      events.push("matrix");
      return Promise.resolve(true);
    },
    hasJoinedInstanceSince: () => Promise.resolve(true),
    requestReboot: () => {
      events.push("reboot");
      return Promise.resolve();
    },
    sleep: (ms) => {
      events.push(`sleep:${ms}`);
      return Promise.resolve();
    },
    loadStatus: () => Promise.resolve(undefined),
    saveStatus: async () => {},
    createOperationId: () => `operation-${++operation}`,
    now: () => new Date(),
    getBootMarker: () => Promise.resolve("boot-marker"),
    ...overrides
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}
