import { connect, type IClientOptions, type IPublishPacket, type MqttClient } from "mqtt";
import type { MqttConfig } from "../config/schema.ts";
import type { AudioModeSummary } from "../service/audioModeService.ts";
import type { ChannelVolumeService } from "../service/channelVolumeService.ts";
import type { ChannelState } from "../audio/types.ts";
import type { Logger } from "../system/logger.ts";
import type { AudioModePublisher } from "./audioModePublisher.ts";
import type { VrChatRecoveryRequestResult } from "../service/vrChatRecoveryService.ts";
import {
  FileAudioMqttStateStore,
  type AudioMqttState,
  type AudioMqttStateStore
} from "./audioMqttStateStore.ts";

interface AudioModeController {
  listModes(): AudioModeSummary[];
  applyMode(id: string): Promise<AudioModeSummary>;
}

export interface MqttAudioSyncDependencies {
  connect?: (url: string, options: IClientOptions) => MqttClient;
  stateStore?: AudioMqttStateStore;
}

const vrChatButtons = [
  {
    action: "recover-last-instance",
    commandTopicSuffix: "vrchat/recover-last-instance/set",
    entityId: "recover_vrchat",
    name: "Recover VRChat"
  },
  {
    action: "start",
    commandTopicSuffix: "vrchat/start/set",
    entityId: "start_vrchat",
    name: "Start VRChat"
  }
] as const;

type VrChatAction = (typeof vrChatButtons)[number]["action"];

/**
 * Bridges confirmed Windows audio state and Home Assistant MQTT discovery.
 * Commands and state use different retained topics: a command only becomes state
 * after the local audio operation has completed successfully.
 */
export class MqttAudioSyncService implements AudioModePublisher {
  private readonly log: Logger;
  private readonly stateStore: AudioMqttStateStore;
  private readonly createClient: (url: string, options: IClientOptions) => MqttClient;
  private readonly topicRoot: string;
  private readonly config: MqttConfig;
  private readonly audioModes: AudioModeController;
  private readonly channels: ChannelVolumeService;
  private readonly vrChatRecovery?: VrChatRecoveryController;
  private client?: MqttClient;
  private state: AudioMqttState = { channelVolumes: {} };
  private stateReady?: Promise<void>;
  private stateSaveTail: Promise<void> = Promise.resolve();
  private removeChannelListener?: () => void;
  private stopped = false;

  constructor(
    config: MqttConfig,
    audioModes: AudioModeController,
    channels: ChannelVolumeService,
    logger: Logger,
    dependencies: MqttAudioSyncDependencies = {},
    vrChatRecovery?: VrChatRecoveryController
  ) {
    this.log = logger.child("mqtt-audio");
    this.config = config;
    this.audioModes = audioModes;
    this.channels = channels;
    this.vrChatRecovery = vrChatRecovery;
    this.stateStore = dependencies.stateStore ?? new FileAudioMqttStateStore();
    this.createClient = dependencies.connect ?? connect;
    this.topicRoot = config.baseTopic.replace(/^\/+|\/+$/g, "");
  }

  start(): void {
    if (this.stateReady || this.stopped) return;
    if (!this.isConfigured()) {
      this.log.warn("MQTT audio sync is disabled or missing broker credentials");
      return;
    }

    this.removeChannelListener = this.channels.onStateChange((state) => {
      void this.recordChannelState(state);
    });
    this.stateReady = this.loadStateAndConnect();
  }

  stop(): void {
    this.stopped = true;
    this.removeChannelListener?.();
    this.removeChannelListener = undefined;
    this.client?.end(false);
    this.client = undefined;
  }

  async publishMode(mode: AudioModeSummary): Promise<void> {
    if (!this.isConfigured() || this.stopped) return;
    await this.ensureStateReady();
    this.state.mode = mode.id;
    await this.persistState();
    await this.publishModeState(mode.id);
  }

  private async loadStateAndConnect(): Promise<void> {
    try {
      this.state = await this.stateStore.load();
    } catch (error) {
      this.log.warn("Could not load saved MQTT audio state", { error: formatError(error) });
    }
    if (!this.stopped) this.connect();
  }

  private connect(): void {
    const availabilityTopic = this.topic("availability");
    this.client = this.createClient(`mqtt://${this.config.host}:${this.config.port}`, {
      clientId: this.config.clientId,
      username: this.config.username,
      password: this.config.password,
      clean: false,
      reconnectPeriod: this.config.reconnectDelayMs,
      will: { topic: availabilityTopic, payload: "offline", qos: 1, retain: true }
    });
    this.client.on("connect", () => {
      void this.onConnected();
    });
    this.client.on("message", (topic, payload, packet) => {
      void this.onMessage(topic, payload.toString(), packet);
    });
    this.client.on("error", (error) => {
      this.log.warn("MQTT broker connection error", { error: error.message });
    });
    this.client.on("close", () => this.log.warn("MQTT broker connection closed; reconnecting"));
  }

  private async onConnected(): Promise<void> {
    this.log.info("Connected to MQTT broker", { host: this.config.host, port: this.config.port });
    await this.subscribe(this.topic("audio/mode/set"));
    await Promise.all(
      vrChatButtons.map((button) => this.subscribe(this.topic(button.commandTopicSuffix)))
    );
    await Promise.all(
      this.channels
        .configuredChannelNames()
        .map((channel) => this.subscribe(this.topic(`audio/volume/${channelSlug(channel)}/set`)))
    );
    await this.subscribe(`${this.config.discoveryPrefix}/status`);
    await this.publishDiscovery();
    await this.publish(this.topic("availability"), "online", true);
    await this.publishAllState();
  }

  private async onMessage(
    topic: string,
    payload: string,
    packet: Pick<IPublishPacket, "retain">
  ): Promise<void> {
    if (topic === `${this.config.discoveryPrefix}/status`) {
      if (payload === "online") {
        await this.publishDiscovery();
        await this.publish(this.topic("availability"), "online", true);
        await this.publishAllState();
      }
      return;
    }
    if (topic === this.topic("audio/mode/set")) {
      const modeId = payload.trim();
      if (!this.audioModes.listModes().some((mode) => mode.id === modeId)) {
        this.log.warn("Ignoring unknown MQTT audio mode", { modeId });
        return;
      }
      try {
        const mode = await this.audioModes.applyMode(modeId);
        await this.publishMode(mode);
      } catch (error) {
        this.log.error("Could not apply MQTT audio mode", { modeId, error: formatError(error) });
      }
      return;
    }
    const vrChatButton = vrChatButtons.find(
      (button) => topic === this.topic(button.commandTopicSuffix)
    );
    if (vrChatButton) {
      // MQTT brokers replay retained messages to every new subscriber. A button
      // press is an event, not state, so replaying it must never start VRChat.
      if (packet.retain) {
        this.log.warn("Ignoring retained MQTT VRChat action", { action: vrChatButton.action });
        return;
      }
      if (payload !== "PRESS") return;
      await this.runVrChatAction(vrChatButton.action);
      return;
    }
    const channel = this.channels
      .configuredChannelNames()
      .find((candidate) => topic === this.topic(`audio/volume/${channelSlug(candidate)}/set`));
    if (!channel) return;

    const value = Number(payload.trim());
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      this.log.warn("Ignoring invalid MQTT volume", { channel, payload });
      return;
    }
    try {
      await this.channels.setVolume(channel, value);
    } catch (error) {
      this.log.error("Could not apply MQTT volume", { channel, value, error: formatError(error) });
    }
  }

  private async recordChannelState(channel: ChannelState): Promise<void> {
    if (!this.isConfigured() || this.stopped) return;
    await this.ensureStateReady();
    this.state.channelVolumes[channel.channelName] = Math.round(channel.endpoint.volumePercent);
    await this.persistState();
    await this.publishChannelState(channel.channelName, Math.round(channel.endpoint.volumePercent));
  }

  private async publishAllState(): Promise<void> {
    if (this.state.mode) await this.publishModeState(this.state.mode);
    await Promise.all(
      Object.entries(this.state.channelVolumes).map(([channel, value]) =>
        this.publishChannelState(channel, value)
      )
    );
    for (const channel of this.channels.listStates()) {
      await this.publishChannelState(
        channel.channelName,
        Math.round(channel.endpoint.volumePercent)
      );
    }
  }

  private async publishModeState(modeId: string): Promise<void> {
    await this.publish(this.topic("audio/mode/state"), modeId, true);
  }

  private async publishChannelState(channel: string, value: number): Promise<void> {
    await this.publish(
      this.topic(`audio/volume/${channelSlug(channel)}/state`),
      String(value),
      true
    );
  }

  private async publishDiscovery(): Promise<void> {
    const prefix = this.config.discoveryPrefix.replace(/\/+$/g, "");
    const deviceId = "raphiiwinutils_shirakami";
    const availability = {
      topic: this.topic("availability"),
      payload_available: "online",
      payload_not_available: "offline"
    };
    const device = {
      identifiers: [deviceId],
      name: "Shirakami",
      manufacturer: "Raphiiko",
      model: "RaphiiWinUtils"
    };
    await this.publish(
      `${prefix}/select/${deviceId}/audio_mode/config`,
      JSON.stringify({
        name: "Audio mode",
        unique_id: `${deviceId}_audio_mode`,
        object_id: "shirakami_audio_mode",
        command_topic: this.topic("audio/mode/set"),
        state_topic: this.topic("audio/mode/state"),
        options: this.audioModes.listModes().map((mode) => mode.id),
        retain: true,
        qos: 1,
        availability,
        device
      }),
      true
    );
    await this.publishVrChatButtonDiscovery(prefix, deviceId, availability, device);
    await Promise.all(
      this.channels.configuredChannelNames().map((channel) =>
        this.publish(
          `${prefix}/number/${deviceId}/${channelSlug(channel)}_volume/config`,
          JSON.stringify({
            name: `${channel} volume`,
            unique_id: `${deviceId}_${channelSlug(channel)}_volume`,
            object_id: `shirakami_${channelSlug(channel)}_volume`,
            command_topic: this.topic(`audio/volume/${channelSlug(channel)}/set`),
            state_topic: this.topic(`audio/volume/${channelSlug(channel)}/state`),
            min: 0,
            max: 100,
            step: 1,
            unit_of_measurement: "%",
            mode: "slider",
            retain: true,
            qos: 1,
            availability,
            device
          }),
          true
        )
      )
    );
  }

  private async publishVrChatButtonDiscovery(
    prefix: string,
    deviceId: string,
    availability: { topic: string; payload_available: string; payload_not_available: string },
    device: { identifiers: string[]; name: string; manufacturer: string; model: string }
  ): Promise<void> {
    await Promise.all(
      vrChatButtons.map((button) =>
        this.publish(
          `${prefix}/button/${deviceId}/${button.entityId}/config`,
          JSON.stringify({
            name: button.name,
            unique_id: `${deviceId}_${button.entityId}`,
            object_id: `shirakami_${button.entityId}`,
            command_topic: this.topic(button.commandTopicSuffix),
            payload_press: "PRESS",
            retain: true,
            qos: 1,
            availability,
            device
          }),
          true
        )
      )
    );
  }

  private async runVrChatAction(action: VrChatAction): Promise<void> {
    if (!this.vrChatRecovery) {
      this.log.warn("Ignoring MQTT VRChat action because recovery is unavailable", { action });
      return;
    }
    const result =
      action === "recover-last-instance"
        ? await this.vrChatRecovery.recoverLastInstance()
        : await this.vrChatRecovery.startVrChat();
    if (!result.accepted) {
      this.log.warn(
        "Ignoring MQTT VRChat action because another action is running or recovery is disabled",
        {
          action
        }
      );
    }
  }

  private async subscribe(topic: string): Promise<void> {
    const client = this.client;
    if (!client?.connected) return;
    await new Promise<void>((resolve, reject) => {
      client.subscribe(topic, { qos: 1 }, (error) => (error ? reject(error) : resolve()));
    });
  }

  private async publish(topic: string, payload: string, retain: boolean): Promise<void> {
    const client = this.client;
    if (!client?.connected) return;
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, payload, { qos: 1, retain }, (error) =>
        error ? reject(error) : resolve()
      );
    });
  }

  private async ensureStateReady(): Promise<void> {
    await (this.stateReady ?? Promise.resolve());
  }

  private async persistState(): Promise<void> {
    const stateSnapshot = structuredClone(this.state);
    const write = this.stateSaveTail.then(() => this.stateStore.save(stateSnapshot));
    this.stateSaveTail = write.catch((error) => {
      this.log.warn("Could not save MQTT audio state", { error: formatError(error) });
    });
    await this.stateSaveTail;
  }

  private isConfigured(): boolean {
    return (
      this.config.enabled &&
      Boolean(this.config.host && this.config.username && this.config.password)
    );
  }

  private topic(suffix: string): string {
    return `${this.topicRoot}/${suffix}`;
  }
}

interface VrChatRecoveryController {
  recoverLastInstance(): Promise<VrChatRecoveryRequestResult>;
  startVrChat(): Promise<VrChatRecoveryRequestResult>;
}

function channelSlug(channel: string): string {
  return channel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
