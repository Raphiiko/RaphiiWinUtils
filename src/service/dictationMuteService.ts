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

export interface DictationMuteCollaborators {
  discord?: Pick<
    DiscordVoiceClient,
    "isReady" | "connect" | "close" | "isInVoiceChannel" | "getMute" | "setMute"
  >;
  watcher?: Pick<HandyLogWatcher, "start" | "stop">;
}

export class DictationMuteService {
  private readonly config: DictationMuteConfig;
  private readonly log: Logger;
  private readonly watcher: NonNullable<DictationMuteCollaborators["watcher"]>;
  private readonly discord: NonNullable<DictationMuteCollaborators["discord"]>;
  private readonly statePath = join(dirname(getConfigPath()), "dictation-mute-state.json");
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private unmuteTimer?: ReturnType<typeof setTimeout>;
  private mutedByUs = false;
  private wanted = true;
  private busy: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    config: DictationMuteConfig,
    logger: Logger,
    collaborators: DictationMuteCollaborators = {}
  ) {
    this.config = config;
    this.log = logger.child("dictation-mute");
    this.watcher =
      collaborators.watcher ?? new HandyLogWatcher(config.handyLogPath, config.pollMs, logger);
    this.discord = collaborators.discord ?? new DiscordVoiceClient(config.discord, logger);
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

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.watcher.stop();
    // Updates restart the service, so a mute left behind here would outlive the dictation.
    if (this.mutedByUs && this.discord.isReady) {
      this.mutedByUs = false;
      try {
        await this.discord.setMute(false);
        this.log.info("Unmuted Discord before shutting down");
      } catch (error) {
        this.log.warn("Could not unmute Discord while shutting down", { error: String(error) });
      }
    }
    this.discord.close();
  }

  /** Live toggle from the dashboard. Survives a service restart. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.wanted = enabled;
    await this.saveWanted();
    this.log.info("Dictation mute toggled", { enabled });

    if (!enabled) {
      this.queue("disable", () => this.applyUnmute());
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
    if (event === "start") {
      // A dictation that starts inside the unmute delay keeps the existing mute.
      if (this.unmuteTimer) clearTimeout(this.unmuteTimer);
      this.unmuteTimer = undefined;
      this.queue("start", () => this.onDictationStart());
      return;
    }

    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    if (!this.mutedByUs || this.unmuteTimer) return;

    // Handy plays its stop chime after the recording ends, and the microphone picks it up.
    this.unmuteTimer = setTimeout(() => {
      this.unmuteTimer = undefined;
      this.queue("stop", () => this.applyUnmute());
    }, this.config.unmuteDelayMs);
  }

  /** Serialize, so a fast start/stop pair cannot read the mute state mid-change. */
  private queue(step: string, run: () => Promise<void>): void {
    this.busy = this.busy.then(run).catch((error) => {
      this.log.warn("Dictation mute step failed", { step, error: String(error) });
    });
  }

  private async onDictationStart(): Promise<void> {
    if (!this.wanted) return;
    if (!this.discord.isReady) {
      await this.connect();
      if (!this.discord.isReady) return;
    }
    if (this.mutedByUs) {
      this.armSafetyRelease();
      return;
    }

    if (!(await this.discord.isInVoiceChannel())) {
      this.log.info("Not in a Discord voice channel; leaving the microphone alone");
      return;
    }

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

  private async applyUnmute(): Promise<void> {
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
      this.queue("safety-release", () => this.applyUnmute());
    }, this.config.maxMuteMs);
  }

  private clearTimers(): void {
    for (const timer of [this.reconnectTimer, this.releaseTimer, this.unmuteTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.reconnectTimer = undefined;
    this.releaseTimer = undefined;
    this.unmuteTimer = undefined;
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
