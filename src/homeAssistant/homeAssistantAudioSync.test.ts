import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config/schema.ts";
import type { AudioModeSummary } from "../service/audioModeService.ts";
import type { ChannelVolumeService } from "../service/channelVolumeService.ts";
import type { Logger } from "../system/logger.ts";
import {
  HomeAssistantAudioSyncService,
  type HomeAssistantClient,
  type HomeAssistantState
} from "./homeAssistantAudioSync.ts";
import type { AudioSyncOutbox, AudioSyncStateStore } from "./audioSyncStateStore.ts";

const mode: AudioModeSummary = {
  id: "speaker",
  name: "Speaker",
  outputDeviceName: "Desktop Speakers",
  micInputSlot: "WIN1.IN",
  micRoutes: []
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

void test("reapplies Home Assistant's persisted desired mode when the PC service starts", async () => {
  const client = new FakeHomeAssistantClient({
    "input_select.raphii_audio_mode": { state: "speaker" }
  });
  const applied: string[] = [];
  const service = createService(client, {
    applyMode: (id) =>
      Promise.resolve().then(() => {
        applied.push(id);
        return mode;
      })
  });

  service.start();
  await waitFor(() => applied.length === 1);
  service.stop();

  assert.deepEqual(applied, ["speaker"]);
  assert.equal(client.statesSet.at(-1)?.entityId, "sensor.raphii_win_utils");
});

void test("writes a locally confirmed mode to both Home Assistant helpers", async () => {
  const client = new FakeHomeAssistantClient();
  const service = createService(client);

  await service.publishMode(mode);

  assert.deepEqual(client.serviceCalls, [
    {
      domain: "input_text",
      service: "set_value",
      data: { entity_id: "input_text.raphii_audio_mode_current", value: "speaker" }
    },
    {
      domain: "input_select",
      service: "select_option",
      data: { entity_id: "input_select.raphii_audio_mode", option: "speaker" }
    }
  ]);
});

function createService(
  client: FakeHomeAssistantClient,
  overrideAudioModes: Partial<{
    listModes(): AudioModeSummary[];
    applyMode(id: string): Promise<AudioModeSummary>;
  }> = {}
): HomeAssistantAudioSyncService {
  const config = structuredClone(defaultConfig.homeAssistant);
  config.enabled = true;
  config.accessToken = "test-token";
  config.syncIntervalMs = 60_000;
  config.volumeEntityIds = {};
  const channels = {
    onStateChange: () => () => {},
    listStates: () => [],
    configuredChannelNames: () => [],
    setVolume: async () => {}
  } as unknown as ChannelVolumeService;
  const audioModes = {
    listModes: () => [mode],
    applyMode: () => Promise.resolve(mode),
    ...overrideAudioModes
  };
  return new HomeAssistantAudioSyncService(
    config,
    audioModes,
    channels,
    logger,
    client,
    new MemoryOutbox()
  );
}

class MemoryOutbox implements AudioSyncStateStore {
  private state: AudioSyncOutbox = { pendingVolumes: {} };

  load(): Promise<AudioSyncOutbox> {
    return Promise.resolve(structuredClone(this.state));
  }

  save(state: AudioSyncOutbox): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

class FakeHomeAssistantClient implements HomeAssistantClient {
  readonly serviceCalls: Array<{
    domain: string;
    service: string;
    data: Record<string, unknown>;
  }> = [];
  readonly statesSet: Array<{
    entityId: string;
    state: string;
    attributes: Record<string, unknown>;
  }> = [];
  private readonly states: Map<string, HomeAssistantState>;

  constructor(states: Record<string, HomeAssistantState> = {}) {
    this.states = new Map(Object.entries(states));
  }

  getState(entityId: string): Promise<HomeAssistantState | undefined> {
    return Promise.resolve(this.states.get(entityId));
  }

  callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    this.serviceCalls.push({ domain, service, data });
    return Promise.resolve();
  }

  setState(entityId: string, state: string, attributes: Record<string, unknown>): Promise<void> {
    this.statesSet.push({ entityId, state, attributes });
    return Promise.resolve();
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not met");
}
