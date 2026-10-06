import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config/schema.ts";
import type {
  AudioEndpointVolumeController,
  AudioEndpointVolumePolicy
} from "../audio/audioEndpointVolumeController.ts";
import type { AudioModePublisher } from "../mqtt/audioModePublisher.ts";
import type { Logger } from "../system/logger.ts";
import { AudioModeService, isSameAudioDevice } from "./audioModeService.ts";

void test("accepts a renamed endpoint label but not a different device", () => {
  const configured = "In Ear Monitors (2- USB-C to 3.5mm Headphone Jack Adapter)";

  assert.equal(
    isSameAudioDevice("Headphones (2- USB-C to 3.5mm Headphone Jack Adapter)", configured),
    true
  );
  assert.equal(
    isSameAudioDevice("Bigscreen Beyond (USB-C to 3.5mm Headphone Jack Adapter)", configured),
    false
  );
  assert.equal(isSameAudioDevice("Headset (3- Arctis Nova Pro Wireless)", configured), false);
  assert.equal(isSameAudioDevice(undefined, configured), false);
  assert.equal(isSameAudioDevice("Nothing Ear", "Nothing Ear"), true);
});

const publisher: AudioModePublisher = {
  publishMode: () => Promise.resolve(),
  publishMic: () => Promise.resolve()
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
    /Could not switch WIN1\.OUT to WDM "Nothing Ear" after 2 attempt\(s\)/
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

void test("skips a pre-switch volume helper call when the endpoint watcher confirms every cap is a no-op", async () => {
  const matrix = new FakeMatrixClient("Desktop Speakers");
  const volumeController = new FakeVolumeController();
  const service = createService(matrix, {
    volumeController,
    filterPreOutputVolumePolicies: () => []
  });

  await service.applyMode("tws");

  assert.deepEqual(volumeController.batches, [[], []]);
});

void test("switches a WDM output to the same device through MME", async () => {
  const matrix = new FakeMatrixClient("Nothing Ear");
  const service = createService(matrix, { outputDriver: "MME" });

  await service.applyMode("tws");

  assert.equal(matrix.currentDriver, "MME");
  assert.ok(
    matrix.commands.includes('Slot(WIN1.OUT).Device.MME = "Nothing Ear";Slot(WIN1.OUT).Online = 1;')
  );
  assert.equal(matrix.commands.includes("Command.Restart = 1;"), false);
});

void test("applies a failed mode once its output appears in Windows, but not after a minute", async () => {
  const matrix = new FakeMatrixClient("Desktop Speakers", true, false);
  const service = createService(matrix);
  await assert.rejects(service.applyMode("tws"));

  await service.retryPendingMode(["Desktop Speakers"]);
  assert.equal(matrix.outputAssignmentAttempts, 2);

  matrix.cacheRefreshed = true;
  await service.retryPendingMode(["Nothing Ear"], Date.now() + 61_000);
  assert.equal(matrix.outputAssignmentAttempts, 2);

  matrix.cacheRefreshed = false;
  await assert.rejects(service.applyMode("tws"));
  matrix.cacheRefreshed = true;
  await service.retryPendingMode(["Nothing Ear"]);
  assert.equal(matrix.currentDeviceName, "Nothing Ear");
});

void test("switches only the mic, and a mode switches back to its preferred mic", async () => {
  const matrix = new FakeMatrixClient("Desktop Speakers");
  const published: string[] = [];
  const service = createService(matrix, {
    publisher: {
      publishMode: (mode) => Promise.resolve(void published.push(`mode:${mode.id}:${mode.mic}`)),
      publishMic: (id) => Promise.resolve(void published.push(`mic:${id}`))
    }
  });
  const desktop = "Point(WIN1.IN[1],VAIO1.OUT[1])";
  const lav = "Point(WIN7.IN[1],VAIO1.OUT[1])";

  await service.applyMode("tws");
  assert.deepEqual([...matrix.routedPoints], [desktop]);

  const outputCommands = matrix.outputAssignmentAttempts;
  await service.applyMic("lav");
  assert.deepEqual([...matrix.routedPoints], [lav]);
  assert.equal(matrix.outputAssignmentAttempts, outputCommands);

  await service.applyMode("tws");
  assert.deepEqual([...matrix.routedPoints], [desktop]);
  await Promise.resolve();
  assert.deepEqual(published, ["mode:tws:desktop", "mic:lav", "mode:tws:desktop"]);
  await assert.rejects(service.applyMic("nope"), /Unknown audio mic: nope/);
});

function createService(
  matrix: FakeMatrixClient,
  options: {
    channelVolumeOverrides?: Record<string, number>;
    outputDriver?: "WDM" | "MME";
    volumeController?: AudioEndpointVolumeController;
    publisher?: AudioModePublisher;
    filterPreOutputVolumePolicies?: (
      policies: AudioEndpointVolumePolicy[]
    ) => AudioEndpointVolumePolicy[];
  } = {}
): AudioModeService {
  const config = structuredClone(defaultConfig);
  config.audioModes.engineSettleMs = 0;
  config.audioModes.routeRetryDelayMs = 0;
  config.audioModes.routeRetryCount = 1;
  config.audioModes.outputRetryCount = 2;
  config.audioModes.micOutputChannels = [1];
  config.audioModes.mics = {
    desktop: {
      name: "Desk Mic",
      inputSlot: "WIN1.IN",
      routes: [{ inputChannel: 1, outputChannel: 1 }]
    },
    lav: { name: "Lav", inputSlot: "WIN7.IN", routes: [{ inputChannel: 1, outputChannel: 1 }] }
  };
  config.audioModes.modes = {
    tws: {
      name: "TWS",
      outputDeviceName: "Nothing Ear",
      mic: "desktop",
      channelVolumeOverrides: options.channelVolumeOverrides,
      outputDriver: options.outputDriver
    }
  };

  return new AudioModeService(config, logger, options.publisher ?? publisher, {
    createMatrixClient: () => matrix,
    delay: () => Promise.resolve(),
    volumeController: options.volumeController ?? new FakeVolumeController(),
    filterPreOutputVolumePolicies: options.filterPreOutputVolumePolicies
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

  publishMic(): Promise<void> {
    return Promise.resolve();
  }

  resolve(): void {
    this.resolvePublish?.();
  }
}

class FakeMatrixClient {
  readonly commands: string[] = [];
  readonly routedPoints = new Set<string>();
  currentDeviceName: string;
  currentDriver = "WDM";
  outputAssignmentAttempts = 0;
  cacheRefreshed: boolean;
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

    if (command.includes(").Reset;")) this.routedPoints.clear();
    for (const match of command.matchAll(/(Point\([^)]+\))\.dBGain = 0\.0/g)) {
      if (match[1]) this.routedPoints.add(match[1]);
    }

    const outputMatch = command.match(/Slot\(WIN1\.OUT\)\.Device\.(\w+) = "([^"]+)"/);
    if (outputMatch?.[1] && outputMatch[2]) {
      this.outputAssignmentAttempts++;
      if (this.cacheRefreshed) {
        this.currentDriver = outputMatch[1];
        this.currentDeviceName = outputMatch[2];
      }
    }

    return Promise.resolve();
  }

  request(command: string): Promise<string[]> {
    if (command.includes(".Device = ?")) {
      return Promise.resolve([
        `Slot(WIN1.OUT).Device.${this.currentDriver} = ${JSON.stringify(this.currentDeviceName)};`
      ]);
    }

    const points = [...command.matchAll(/(Point\([^)]+\))\.dBGain = \?;/g)].map(
      (match) => match[1]
    );
    if (points.length > 0) {
      const gain = (point: string | undefined) =>
        point && this.routedPoints.has(point) ? "0.0" : "-inf";
      return Promise.resolve([points.map((point) => `${point}.dBGain = ${gain(point)};`).join("")]);
    }

    return Promise.resolve([]);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
