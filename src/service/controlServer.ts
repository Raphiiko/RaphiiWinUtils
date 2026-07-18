import { Elysia } from "elysia";
import { node } from "@elysiajs/node";
import type { ControlConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import { AudioModeService, UnknownAudioModeError } from "./audioModeService.ts";
import {
  ChannelVolumeService,
  InvalidAudioVolumeError,
  UnknownAudioChannelError
} from "./channelVolumeService.ts";
import type { Updater } from "./updater.ts";

export class ControlServer {
  private readonly log: Logger;
  private readonly config: ControlConfig;
  private readonly updater: Updater;
  private readonly audioModes: AudioModeService;
  private readonly channelVolumes: ChannelVolumeService;
  private app?: { stop: () => unknown };

  constructor(
    config: ControlConfig,
    updater: Updater,
    audioModes: AudioModeService,
    channelVolumes: ChannelVolumeService,
    logger: Logger
  ) {
    this.config = config;
    this.updater = updater;
    this.audioModes = audioModes;
    this.channelVolumes = channelVolumes;
    this.log = logger.child("control");
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Control API disabled");
      return;
    }

    this.app = new Elysia({ adapter: node() })
      .get("/health", () => ({
        ok: true,
        service: "RaphiiWinUtils",
        updater: this.updater.getStatus()
      }))
      .post("/update/check", ({ set }) => {
        const accepted = this.updater.requestCheck("control-api");
        set.status = accepted ? 202 : 409;
        return {
          accepted,
          updater: this.updater.getStatus()
        };
      })
      .get("/audio/modes", () => ({
        modes: this.audioModes.listModes()
      }))
      .get("/audio/volumes", () => ({
        channels: this.channelVolumes.listStates().map((state) => ({
          name: state.channelName,
          volumePercent: state.endpoint.volumePercent,
          muted: state.muted
        }))
      }))
      .post("/audio/modes/:id", async ({ params, set }) => {
        try {
          const mode = await this.audioModes.applyMode(params.id);
          return {
            applied: true,
            mode
          };
        } catch (error) {
          if (error instanceof UnknownAudioModeError) {
            set.status = 404;
            return {
              applied: false,
              error: error.message
            };
          }

          set.status = 500;
          this.log.error("Failed to apply audio mode", { error: String(error) });
          return {
            applied: false,
            error: "Failed to apply audio mode"
          };
        }
      })
      .post("/audio/volumes/:name", async ({ params, body, set }) => {
        const volumePercent = (body as { volumePercent?: unknown } | undefined)?.volumePercent;
        try {
          await this.channelVolumes.setVolume(params.name, Number(volumePercent));
          set.status = 202;
          return { accepted: true };
        } catch (error) {
          if (
            error instanceof UnknownAudioChannelError ||
            error instanceof InvalidAudioVolumeError
          ) {
            set.status = 400;
            return { accepted: false, error: error.message };
          }

          set.status = 500;
          this.log.error("Failed to set audio channel volume", { error: String(error) });
          return { accepted: false, error: "Failed to set audio channel volume" };
        }
      })
      .listen({
        hostname: this.config.host,
        port: this.config.port
      });

    this.log.info("Control API listening", {
      host: this.config.host,
      port: this.config.port
    });
  }

  stop(): void {
    this.app?.stop();
    this.app = undefined;
  }
}
