import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config/schema.ts";
import type {
  AudioEndpointVolumeController,
  AudioEndpointVolumePolicy
} from "../audio/audioEndpointVolumeController.ts";
import type { AudioModePublisher } from "../mqtt/audioModePublisher.ts";
import type { Logger } from "../system/logger.ts";
import { AudioModeService } from "./audioModeService.ts";

const publisher: AudioModePublisher = {
  publishMode: () => Promise.resolve()
};

const logger = {
  child() {
    return this;
  },
  debug() {},
  info() {},
  warn() {},
  error() {}
} as unknown as Logger;

void test("switches a Matrix output without restarting when the device assignment succeeds", async () => {
  const matrix = new FakeMatrixClient("Desktop Speakers");
  const service = createService(matrix);

  await service.applyMode("tws");

  assert.equal(matrix.currentDeviceName, "Nothing Ear");
  assert.equal(matrix.commands.includes("Command.Restart = 1;"), false);
});

void test("restarts Matrix and retries when a newly connected output is not in its device cache", async () => {
  const matrix = new FakeMatrixClient("Desktop Speakers", true);
  const service = createService(matrix);

  await service.applyMode("tws");

  assert.equal(matrix.currentDeviceName, "Nothing Ear");
  assert.equal(matrix.commands.filter((command) => command === "Command.Restart = 1;").length, 1);
  assert.equal(matrix.outputAssignmentAttempts, 2);
});

void test("fails instead of reporting success when Matrix still cannot select the output", async () => {
  const matrix = new FakeMatrixClient("Desktop Speakers", true, false);
  const service = createService(matrix);

  await assert.rejects(
    service.applyMode("tws"),
    /Could not switch WIN1\.OUT to "Nothing Ear" after 2 attempt\(s\)/
  );
});

void test("applies mode overrides only after the new output is selected", async () => {
  const events: string[] = [];
  const matrix = new FakeMatrixClient("Desktop Speakers", false, true, (command) => {
    if (command.includes('.Device.WDM = "Nothing Ear"')) events.push("output");
  });
  const volumeController: AudioEndpointVolumeController = {
    apply(policies) {
      events.push(policies[0]?.mode ?? "empty");
      return Promise.resolve();
    }
  };
  const service = createService(matrix, {
    channelVolumeOverrides: { Game: 100 },
    volumeController
  });

  await service.applyMode("tws");

  assert.deepEqual(events.slice(0, 3), ["cap", "output", "set"]);
});

void test("publishes only after the Matrix output and mic route are verified", async () => {
  const events: string[] = [];
  const matrix = new FakeMatrixClient("Desktop Speakers", false, true, (command) => {
    if (command.includes('.Device.WDM = "Nothing Ear"')) events.push("output");
  });
  const publisher = new DeferredPublisher(() => events.push("publish"));
  const service = createService(matrix, { publisher });

  await service.applyMode("tws");
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }

  assert.deepEqual(events.slice(0, 2), ["output", "publish"]);
  assert.equal(matrix.currentDeviceName, "Nothing Ear");
  publisher.resolve();
});

void test("switches the output while a slow pre-switch volume cap continues", async () => {
  const matrix = new FakeMatrixClient("Desktop Speakers");
  const volumeController = new DeferredFirstVolumeController();
  const service = createService(matrix, { volumeController });

  const applyPromise = service.applyMode("tws");
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }

  assert.equal(matrix.currentDeviceName, "Nothing Ear");
  assert.equal(volumeController.applyCount, 1);

  volumeController.resolveFirstApply();
  await applyPromise;
});

function createService(
  matrix: FakeMatrixClient,
  options: {
    channelVolumeOverrides?: Record<string, number>;
    volumeController?: AudioEndpointVolumeController;
    publisher?: AudioModePublisher;
  } = {}
): AudioModeService {
  const config = structuredClone(defaultConfig);
  config.audioModes.engineSettleMs = 0;
  config.audioModes.routeRetryDelayMs = 0;
  config.audioModes.routeRetryCount = 1;
  config.audioModes.outputRetryCount = 2;
  config.audioModes.micOutputChannels = [1];
  config.audioModes.modes = {
    tws: {
      name: "TWS",
      outputDeviceName: "Nothing Ear",
      micInputSlot: "WIN1.IN",
      micRoutes: [{ inputChannel: 1, outputChannel: 1 }],
      channelVolumeOverrides: options.channelVolumeOverrides
    }
  };

  return new AudioModeService(config, logger, options.publisher ?? publisher, {
    createMatrixClient: () => matrix,
    delay: () => Promise.resolve(),
    volumeController: options.volumeController ?? new FakeVolumeController()
  });
}

class FakeVolumeController implements AudioEndpointVolumeController {
  readonly batches: AudioEndpointVolumePolicy[][] = [];

  apply(policies: AudioEndpointVolumePolicy[]): Promise<void> {
    this.batches.push(policies);
    return Promise.resolve();
  }
}

class DeferredFirstVolumeController implements AudioEndpointVolumeController {
  applyCount = 0;
  private resolveFirst?: () => void;

  apply(): Promise<void> {
    this.applyCount++;
    if (this.applyCount > 1) return Promise.resolve();

    return new Promise((resolve) => {
      this.resolveFirst = resolve;
    });
  }

  resolveFirstApply(): void {
    this.resolveFirst?.();
  }
}

class DeferredPublisher implements AudioModePublisher {
  private resolvePublish?: () => void;
  private readonly onPublish: () => void;

  constructor(onPublish: () => void) {
    this.onPublish = onPublish;
  }

  publishMode(): Promise<void> {
    this.onPublish();
    return new Promise((resolve) => {
      this.resolvePublish = resolve;
    });
  }

  resolve(): void {
    this.resolvePublish?.();
  }
}

class FakeMatrixClient {
  readonly commands: string[] = [];
  currentDeviceName: string;
  outputAssignmentAttempts = 0;
  private cacheRefreshed: boolean;
  private readonly refreshOnRestart: boolean;
  private readonly onSend?: (command: string) => void;

  constructor(
    currentDeviceName: string,
    assignmentRequiresRefresh = false,
    refreshOnRestart = true,
    onSend?: (command: string) => void
  ) {
    this.currentDeviceName = currentDeviceName;
    this.cacheRefreshed = !assignmentRequiresRefresh;
    this.refreshOnRestart = refreshOnRestart;
    this.onSend = onSend;
  }

  send(command: string): Promise<void> {
    this.commands.push(command);
    this.onSend?.(command);

    if (command === "Command.Restart = 1;") {
      if (this.refreshOnRestart) this.cacheRefreshed = true;
      return Promise.resolve();
    }

    const outputMatch = command.match(/Slot\(WIN1\.OUT\)\.Device\.WDM = "([^"]+)"/);
    if (outputMatch?.[1]) {
      this.outputAssignmentAttempts++;
      if (this.cacheRefreshed) this.currentDeviceName = outputMatch[1];
    }

    return Promise.resolve();
  }

  request(command: string): Promise<string[]> {
    if (command.includes(".Device.WDM")) {
      return Promise.resolve([
        `Slot(WIN1.OUT).Device.WDM = ${JSON.stringify(this.currentDeviceName)};`
      ]);
    }

    if (command.includes(".dBGain")) {
      return Promise.resolve([`${command.replace("?", "0.0")}`]);
    }

    return Promise.resolve([]);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
