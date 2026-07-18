import assert from "node:assert/strict";
import test from "node:test";
import type { MqttClient } from "mqtt";
import { defaultConfig } from "../config/schema.ts";
import type { AudioModeSummary } from "../service/audioModeService.ts";
import type { ChannelVolumeService } from "../service/channelVolumeService.ts";
import type { Logger } from "../system/logger.ts";
import type { AudioMqttState, AudioMqttStateStore } from "./audioMqttStateStore.ts";
import { MqttAudioSyncService } from "./mqttAudioSync.ts";

const deskSpeakers: AudioModeSummary = {
  id: "desk-speakers",
  name: "Desk Speakers",
  outputDeviceName: "Desktop Speakers",
  micInputSlot: "WIN1.IN",
  micRoutes: []
};

const allAudioModes = [
  { id: "headset-desk-mic", name: "Headset + Desk Mic" },
  { id: "beyond", name: "Beyond" },
  { id: "headset", name: "Headset" },
  { id: "iems", name: "IEMs" },
  { id: "desk-speakers", name: "Desk Speakers" },
  { id: "tws", name: "TWS" }
].map(({ id, name }) => ({ ...deskSpeakers, id, name }));

const logger = {
  child() {
    return this;
  },
  debug() {},
  info() {},
  warn() {},
  error() {}
} as unknown as Logger;

void test("publishes discovery and only confirms an MQTT mode after the local controller succeeds", async () => {
  const client = new FakeMqttClient();
  const modesApplied: string[] = [];
  const service = new MqttAudioSyncService(
    { ...defaultConfig.mqtt, enabled: true, password: "test-password" },
    {
      listModes: () => allAudioModes,
      applyMode: (id) => {
        modesApplied.push(id);
        return Promise.resolve(deskSpeakers);
      }
    },
    createChannels() as unknown as ChannelVolumeService,
    logger,
    { connect: () => client as unknown as MqttClient, stateStore: new MemoryStateStore() }
  );

  service.start();
  await waitFor(() => client.hasListener("connect"));
  client.emit("connect");
  await waitFor(() =>
    client.published.some((message) => message.topic.endsWith("audio_mode/config"))
  );
  const discovery = JSON.parse(
    client.published.find((message) => message.topic.endsWith("audio_mode/config"))?.payload ?? "{}"
  ) as { options?: string[] };
  assert.deepEqual(discovery.options, [
    "headset-desk-mic",
    "beyond",
    "headset",
    "iems",
    "desk-speakers",
    "tws"
  ]);

  assert.equal(
    client.published.some(
      (message) =>
        message.topic === "raphiiwinutils/shirakami/audio/mode/state" &&
        message.payload === "desk-speakers"
    ),
    false
  );

  client.emit("message", "raphiiwinutils/shirakami/audio/mode/set", Buffer.from("desk-speakers"));
  await waitFor(() => modesApplied.length === 1);
  await waitFor(() =>
    client.published.some(
      (message) =>
        message.topic === "raphiiwinutils/shirakami/audio/mode/state" &&
        message.payload === "desk-speakers"
    )
  );

  assert.deepEqual(modesApplied, ["desk-speakers"]);
  assert.equal(
    client.published.find((message) => message.topic.endsWith("audio_mode/config"))?.retain,
    true
  );
  service.stop();
});

void test("publishes VRChat buttons and routes their presses to the recovery service", async () => {
  const client = new FakeMqttClient();
  let recoverCalls = 0;
  let startCalls = 0;
  const service = new MqttAudioSyncService(
    { ...defaultConfig.mqtt, enabled: true, password: "test-password" },
    { listModes: () => [deskSpeakers], applyMode: () => Promise.resolve(deskSpeakers) },
    createChannels() as unknown as ChannelVolumeService,
    logger,
    { connect: () => client as unknown as MqttClient, stateStore: new MemoryStateStore() },
    {
      recoverLastInstance: () => {
        recoverCalls += 1;
        return Promise.resolve({ accepted: true });
      },
      startVrChat: () => {
        startCalls += 1;
        return Promise.resolve({ accepted: true });
      }
    }
  );

  service.start();
  await waitFor(() => client.hasListener("connect"));
  client.emit("connect");
  await waitFor(() =>
    client.published.some((message) => message.topic.endsWith("recover_vrchat/config"))
  );

  const recoveryButton = client.published.find((message) =>
    message.topic.endsWith("recover_vrchat/config")
  );
  assert.deepEqual(JSON.parse(recoveryButton?.payload ?? "{}"), {
    name: "Recover VRChat",
    unique_id: "raphiiwinutils_shirakami_recover_vrchat",
    object_id: "shirakami_recover_vrchat",
    command_topic: "raphiiwinutils/shirakami/vrchat/recover-last-instance/set",
    payload_press: "PRESS",
    retain: true,
    qos: 1,
    availability: {
      topic: "raphiiwinutils/shirakami/availability",
      payload_available: "online",
      payload_not_available: "offline"
    },
    device: {
      identifiers: ["raphiiwinutils_shirakami"],
      name: "Shirakami",
      manufacturer: "Raphiiko",
      model: "RaphiiWinUtils"
    }
  });

  client.emit(
    "message",
    "raphiiwinutils/shirakami/vrchat/recover-last-instance/set",
    Buffer.from("PRESS"),
    { retain: false }
  );
  client.emit("message", "raphiiwinutils/shirakami/vrchat/start/set", Buffer.from("PRESS"), {
    retain: false
  });
  await waitFor(() => recoverCalls === 1 && startCalls === 1);
  service.stop();
});

void test("does not replay retained MQTT VRChat button presses", async () => {
  const client = new FakeMqttClient();
  let recoverCalls = 0;
  const service = new MqttAudioSyncService(
    { ...defaultConfig.mqtt, enabled: true, password: "test-password" },
    { listModes: () => [deskSpeakers], applyMode: () => Promise.resolve(deskSpeakers) },
    createChannels() as unknown as ChannelVolumeService,
    logger,
    { connect: () => client as unknown as MqttClient, stateStore: new MemoryStateStore() },
    {
      recoverLastInstance: () => {
        recoverCalls += 1;
        return Promise.resolve({ accepted: true });
      },
      startVrChat: () => Promise.resolve({ accepted: true })
    }
  );

  service.start();
  await waitFor(() => client.hasListener("connect"));
  client.emit("connect");
  await waitFor(() => client.hasListener("message"));

  client.emit(
    "message",
    "raphiiwinutils/shirakami/vrchat/recover-last-instance/set",
    Buffer.from("PRESS"),
    { retain: true }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(recoverCalls, 0);
  service.stop();
});

function createChannels(): object {
  return {
    onStateChange: () => () => {},
    configuredChannelNames: () => ["System"],
    listStates: () => [],
    setVolume: async () => {}
  };
}

class MemoryStateStore implements AudioMqttStateStore {
  private state: AudioMqttState = { channelVolumes: {} };

  load(): Promise<AudioMqttState> {
    return Promise.resolve(structuredClone(this.state));
  }

  save(state: AudioMqttState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

class FakeMqttClient {
  connected = true;
  readonly published: Array<{ topic: string; payload: string; retain: boolean }> = [];
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  subscribe(_topic: string, _options: unknown, callback: (error?: Error) => void): this {
    callback();
    return this;
  }

  publish(
    topic: string,
    payload: string,
    options: { retain: boolean },
    callback: (error?: Error) => void
  ): this {
    this.published.push({ topic, payload, retain: options.retain });
    callback();
    return this;
  }

  end(): this {
    return this;
  }

  hasListener(event: string): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not met");
}
