import type { ChannelState } from "../audio/types.ts";
import type { HomeAssistantConfig } from "../config/schema.ts";
import type { AudioModeSummary } from "../service/audioModeService.ts";
import type { ChannelVolumeService } from "../service/channelVolumeService.ts";
import type { Logger } from "../system/logger.ts";
import type { AudioModePublisher } from "./audioModePublisher.ts";
import {
  FileAudioSyncStateStore,
  type AudioSyncOutbox,
  type AudioSyncStateStore
} from "./audioSyncStateStore.ts";

export interface HomeAssistantState {
  state: string;
}

export interface HomeAssistantClient {
  getState(entityId: string): Promise<HomeAssistantState | undefined>;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<void>;
  setState(entityId: string, state: string, attributes: Record<string, unknown>): Promise<void>;
}

export interface AudioModeController {
  listModes(): AudioModeSummary[];
  applyMode(id: string): Promise<AudioModeSummary>;
}

export interface RaphiiWinUtilsDiagnostics {
  clipboardAutomationEnabled: boolean;
  xsOverlayRecoveryEnabled: boolean;
  updaterEnabled: boolean;
  localControlApiEnabled: boolean;
}

export class HomeAssistantRestClient implements HomeAssistantClient {
  private readonly config: HomeAssistantConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HomeAssistantConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async getState(entityId: string): Promise<HomeAssistantState | undefined> {
    const response = await this.request(`/api/states/${encodeURIComponent(entityId)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw await responseError("get state", entityId, response);
    return (await response.json()) as HomeAssistantState;
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    const response = await this.request(`/api/services/${domain}/${service}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    });
    if (!response.ok) throw await responseError("call service", `${domain}.${service}`, response);
  }

  async setState(
    entityId: string,
    state: string,
    attributes: Record<string, unknown>
  ): Promise<void> {
    const response = await this.request(`/api/states/${encodeURIComponent(entityId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, attributes })
    });
    if (!response.ok) throw await responseError("set state", entityId, response);
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.config.url.replace(/\/$/, "")}${path}`;
    return this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        ...init.headers
      },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    });
  }
}

/**
 * Keeps HA helpers as the durable desired state. HA persists helpers while the PC is off; this
 * service reconciles them whenever either side comes back, without exposing the local API to LAN.
 */
export class HomeAssistantAudioSyncService implements AudioModePublisher {
  private readonly log: Logger;
  private readonly client: HomeAssistantClient;
  private readonly config: HomeAssistantConfig;
  private readonly audioModes: AudioModeController;
  private readonly channelVolumes: ChannelVolumeService;
  private readonly stateStore: AudioSyncStateStore;
  private readonly diagnostics: RaphiiWinUtilsDiagnostics;
  private readonly desiredVolumes = new Map<string, number>();
  private readonly pendingVolumeTargets = new Map<string, number>();
  private syncTimer?: ReturnType<typeof setInterval>;
  private unsubscribeChannelStates?: () => void;
  private syncTail: Promise<void> = Promise.resolve();
  private outboxTail: Promise<unknown> = Promise.resolve();
  private outbox?: AudioSyncOutbox;
  private outboxLoad?: Promise<AudioSyncOutbox>;
  private lastDesiredMode?: string;

  constructor(
    config: HomeAssistantConfig,
    audioModes: AudioModeController,
    channelVolumes: ChannelVolumeService,
    logger: Logger,
    client: HomeAssistantClient = new HomeAssistantRestClient(config),
    stateStore: AudioSyncStateStore = new FileAudioSyncStateStore(),
    diagnostics: RaphiiWinUtilsDiagnostics = {
      clipboardAutomationEnabled: false,
      xsOverlayRecoveryEnabled: false,
      updaterEnabled: false,
      localControlApiEnabled: false
    }
  ) {
    this.config = config;
    this.audioModes = audioModes;
    this.channelVolumes = channelVolumes;
    this.log = logger.child("home-assistant-audio");
    this.client = client;
    this.stateStore = stateStore;
    this.diagnostics = diagnostics;
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Home Assistant audio sync disabled");
      return;
    }
    if (!this.config.url.trim() || !this.config.accessToken.trim()) {
      this.log.error("Home Assistant audio sync requires url and accessToken");
      return;
    }

    this.unsubscribeChannelStates = this.channelVolumes.onStateChange((state) => {
      void this.publishVolume(state).catch((error: unknown) => {
        this.log.warn("Could not publish local volume change to Home Assistant", {
          channelName: state.channelName,
          error: formatError(error)
        });
      });
    });
    this.requestSync();
    this.syncTimer = setInterval(
      () => this.requestSync(),
      Math.max(1000, this.config.syncIntervalMs)
    );
    this.log.info("Home Assistant audio sync started", {
      modeEntityId: this.config.audioModeEntityId,
      currentModeEntityId: this.config.currentAudioModeEntityId,
      volumeEntityIds: this.config.volumeEntityIds,
      syncIntervalMs: this.config.syncIntervalMs
    });
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = undefined;
    this.unsubscribeChannelStates?.();
    this.unsubscribeChannelStates = undefined;
  }

  async publishMode(mode: AudioModeSummary): Promise<void> {
    if (!this.config.enabled) return;
    await this.queueOutbox(async () => {
      const outbox = await this.getOutbox();
      this.lastDesiredMode = mode.id;
      outbox.pendingMode = mode.id;
      await this.stateStore.save(outbox);
      await this.flushOutbox();
    });
  }

  private requestSync(): void {
    this.syncTail = this.syncTail
      .then(() => this.sync())
      .catch((error: unknown) => {
        this.log.warn("Home Assistant audio synchronization failed; will retry", {
          error: formatError(error)
        });
      });
  }

  private async sync(): Promise<void> {
    await this.queueOutbox(() => this.flushOutbox());
    await this.syncDesiredMode();
    await this.initializeVolumesFromPcIfNeeded();
    await Promise.all(
      this.channelVolumes
        .configuredChannelNames()
        .map((channelName) => this.syncDesiredVolume(channelName))
    );
    await Promise.all(this.channelVolumes.listStates().map((state) => this.publishVolume(state)));
    await this.publishDebugStatus();
  }

  private async syncDesiredMode(): Promise<void> {
    const state = await this.client.getState(this.config.audioModeEntityId);
    const modeId = state?.state.trim();
    if (!modeId || modeId === "unknown" || modeId === "unavailable") return;
    if (!this.audioModes.listModes().some((mode) => mode.id === modeId)) {
      this.log.warn("Home Assistant requested an unknown audio mode", { modeId });
      return;
    }
    if (modeId === this.lastDesiredMode) return;

    this.lastDesiredMode = modeId;
    try {
      await this.audioModes.applyMode(modeId);
    } catch (error) {
      this.lastDesiredMode = undefined;
      throw error;
    }
  }

  private async syncDesiredVolume(channelName: string): Promise<void> {
    const entityId = this.entityForChannel(channelName);
    if (!entityId) return;

    const state = await this.client.getState(entityId);
    const desired = parseVolume(state?.state);
    if (desired === undefined) return;
    if (this.desiredVolumes.get(channelName) === desired) return;

    this.desiredVolumes.set(channelName, desired);
    const current = this.channelVolumes
      .listStates()
      .find((candidate) => candidate.channelName.toLowerCase() === channelName.toLowerCase());
    if (!current || current.endpoint.volumePercent === desired) return;

    this.pendingVolumeTargets.set(channelName, desired);
    try {
      await this.channelVolumes.setVolume(channelName, desired);
    } catch (error) {
      this.pendingVolumeTargets.delete(channelName);
      throw error;
    }
  }

  private async publishVolume(state: ChannelState): Promise<void> {
    if (!this.config.enabled) return;
    const entityId = this.entityForChannel(state.channelName);
    if (!entityId) return;

    const pendingTarget = this.pendingVolumeTargets.get(state.channelName);
    if (pendingTarget !== undefined) {
      if (pendingTarget !== state.endpoint.volumePercent) return;
      this.pendingVolumeTargets.delete(state.channelName);
    }

    await this.queueOutbox(async () => {
      const outbox = await this.getOutbox();
      this.desiredVolumes.set(state.channelName, state.endpoint.volumePercent);
      outbox.pendingVolumes[state.channelName] = state.endpoint.volumePercent;
      await this.stateStore.save(outbox);
      await this.flushOutbox();
    });
  }

  private entityForChannel(channelName: string): string | undefined {
    return Object.entries(this.config.volumeEntityIds).find(
      ([configuredName]) => configuredName.toLowerCase() === channelName.toLowerCase()
    )?.[1];
  }

  private async initializeVolumesFromPcIfNeeded(): Promise<void> {
    const initialized = await this.client.getState(this.config.volumeInitializationEntityId);
    if (initialized?.state !== "off") return;

    const states = this.channelVolumes.listStates();
    const hasEveryConfiguredChannel = this.channelVolumes
      .configuredChannelNames()
      .every((channelName) =>
        states.some((state) => state.channelName.toLowerCase() === channelName.toLowerCase())
      );
    if (!hasEveryConfiguredChannel) return;

    await Promise.all(
      states.map((state) => {
        const entityId = this.entityForChannel(state.channelName);
        return entityId
          ? this.client.callService("input_number", "set_value", {
              entity_id: entityId,
              value: state.endpoint.volumePercent
            })
          : Promise.resolve();
      })
    );
    await this.client.callService("input_boolean", "turn_on", {
      entity_id: this.config.volumeInitializationEntityId
    });
  }

  private async getOutbox(): Promise<AudioSyncOutbox> {
    if (this.outbox) return this.outbox;
    this.outboxLoad ??= this.stateStore.load();
    this.outbox = await this.outboxLoad;
    return this.outbox;
  }

  private queueOutbox<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.outboxTail.then(operation);
    this.outboxTail = result.catch(() => undefined);
    return result;
  }

  private async flushOutbox(): Promise<void> {
    const outbox = await this.getOutbox();
    if (outbox.pendingMode) {
      const modeId = outbox.pendingMode;
      await Promise.all([
        this.client.callService("input_text", "set_value", {
          entity_id: this.config.currentAudioModeEntityId,
          value: modeId
        }),
        this.client.callService("input_select", "select_option", {
          entity_id: this.config.audioModeEntityId,
          option: modeId
        })
      ]);
      this.lastDesiredMode = modeId;
      delete outbox.pendingMode;
      await this.stateStore.save(outbox);
    }

    for (const [channelName, volumePercent] of Object.entries(outbox.pendingVolumes)) {
      const entityId = this.entityForChannel(channelName);
      if (!entityId) continue;
      await this.client.callService("input_number", "set_value", {
        entity_id: entityId,
        value: volumePercent
      });
      delete outbox.pendingVolumes[channelName];
      await this.stateStore.save(outbox);
    }
  }

  private async publishDebugStatus(): Promise<void> {
    await this.client.setState("sensor.raphii_win_utils", "online", {
      friendly_name: "RaphiiWinUtils",
      available_audio_modes: this.audioModes.listModes().map((mode) => ({
        id: mode.id,
        name: mode.name
      })),
      requested_audio_mode: this.lastDesiredMode ?? "unknown",
      features: {
        clipboard_automation: this.diagnostics.clipboardAutomationEnabled,
        xsoverlay_recovery: this.diagnostics.xsOverlayRecoveryEnabled,
        self_updater: this.diagnostics.updaterEnabled,
        local_control_api: this.diagnostics.localControlApiEnabled
      },
      channel_volumes: Object.fromEntries(
        this.channelVolumes.listStates().map((channel) => [
          channel.channelName,
          {
            volume_percent: channel.endpoint.volumePercent,
            muted: channel.muted,
            endpoint: channel.endpoint.name
          }
        ])
      ),
      updated_at: new Date().toISOString()
    });
  }
}

function parseVolume(value: string | undefined): number | undefined {
  if (!value || value === "unknown" || value === "unavailable") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

async function responseError(action: string, target: string, response: Response): Promise<Error> {
  const body = (await response.text()).trim();
  return new Error(
    `Home Assistant could not ${action} ${target}: ${response.status}${
      body ? `: ${body.slice(0, 500)}` : ""
    }`
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
