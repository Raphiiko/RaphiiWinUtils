import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigPath } from "../config/loadConfig.ts";
import type { DictationMuteConfig } from "../config/schema.ts";
import { HandyLogWatcher, type DictationEvent } from "../dictation/handyLogWatcher.ts";
import {
  DiscordAuthorizationRequiredError,
  DiscordVoiceClient
} from "../discord/discordVoiceClient.ts";
import { Logger } from "../system/logger.ts";

const reconnectDelayMs = 30_000;

export interface DictationMuteStatus {
  available: boolean;
  enabled: boolean;
  connected: boolean;
  muted: boolean;
}

export class DictationMuteService {
  private readonly config: DictationMuteConfig;
  private readonly log: Logger;
  private readonly watcher: HandyLogWatcher;
  private readonly discord: DiscordVoiceClient;
  private readonly statePath = join(dirname(getConfigPath()), "dictation-mute-state.json");
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private mutedByUs = false;
  private wanted = true;
  private busy: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(config: DictationMuteConfig, logger: Logger) {
    this.config = config;
    this.log = logger.child("dictation-mute");
    this.watcher = new HandyLogWatcher(config.handyLogPath, config.pollMs, logger);
    this.discord = new DiscordVoiceClient(config.discord, logger);
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Dictation mute disabled");
      return;
    }
    if (!this.config.discord.clientId || !this.config.discord.clientSecret) {
      this.log.warn("Dictation mute needs a Discord client id and secret in config.json");
      return;
    }

    this.stopped = false;
    void this.restoreWanted().then(() => this.connect());
    this.watcher.start((event) => this.handleEvent(event));
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.reconnectTimer = undefined;
    this.releaseTimer = undefined;
    this.watcher.stop();
    this.discord.close();
  }

  /** Live toggle from the dashboard. Survives a service restart. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.wanted = enabled;
    await this.saveWanted();
    this.log.info("Dictation mute toggled", { enabled });

    if (!enabled) {
      this.handleEvent("stop");
      return;
    }
    await this.connect();
  }

  getStatus(): DictationMuteStatus {
    return {
      available: this.config.enabled,
      enabled: this.config.enabled && this.wanted,
      connected: this.discord.isReady,
      muted: this.mutedByUs
    };
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.wanted || this.discord.isReady) return;

    try {
      await this.discord.connect();
    } catch (error) {
      if (error instanceof DiscordAuthorizationRequiredError) {
        this.log.warn("Waiting on Discord authorization", { error: error.message });
      } else {
        this.log.info("Discord RPC not available yet", { error: String(error) });
      }
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, reconnectDelayMs);
  }

  private handleEvent(event: DictationEvent): void {
    // Serialize, so a fast start/stop pair cannot read the mute state mid-change.
    this.busy = this.busy
      .then(() => (event === "start" ? this.onDictationStart() : this.onDictationStop()))
      .catch((error) => {
        this.log.warn("Dictation mute step failed", { event, error: String(error) });
      });
  }

  private async onDictationStart(): Promise<void> {
    if (!this.wanted) return;
    if (!this.discord.isReady) {
      await this.connect();
      if (!this.discord.isReady) return;
    }
    if (this.mutedByUs) return;

    // Leave a mute the user set themselves alone, both now and at dictation stop.
    if (await this.discord.getMute()) {
      this.log.info("Discord already muted; leaving it alone");
      return;
    }

    await this.discord.setMute(true);
    this.mutedByUs = true;
    this.armSafetyRelease();
    this.log.info("Muted Discord for dictation");
  }

  private async onDictationStop(): Promise<void> {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    if (!this.mutedByUs) return;

    this.mutedByUs = false;
    if (!this.discord.isReady) return;

    await this.discord.setMute(false);
    this.log.info("Unmuted Discord after dictation");
  }

  /** A missed stop event must never leave the microphone muted for the rest of the call. */
  private armSafetyRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      this.log.warn("Dictation ran past the mute limit; unmuting", {
        maxMuteMs: this.config.maxMuteMs
      });
      this.handleEvent("stop");
    }, this.config.maxMuteMs);
  }

  private async restoreWanted(): Promise<void> {
    if (!existsSync(this.statePath)) return;

    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8")) as { enabled?: unknown };
      if (typeof value.enabled === "boolean") this.wanted = value.enabled;
    } catch (error) {
      this.log.warn("Could not read dictation mute state", { error: String(error) });
    }
  }

  private async saveWanted(): Promise<void> {
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ enabled: this.wanted })}\n`, "utf8");
    await rename(temporaryPath, this.statePath);
  }
}
