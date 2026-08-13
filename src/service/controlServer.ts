import { Elysia, t } from "elysia";
import { node } from "@elysiajs/node";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControlConfig } from "../config/schema.ts";
import { launchDetached } from "../system/process.ts";
import { wallpaperRoutes } from "../wallpaper/wallpaperRoutes.ts";
import { WallpaperService } from "../wallpaper/wallpaperService.ts";
import { FileAudioMqttStateStore } from "../mqtt/audioMqttStateStore.ts";
import { Logger } from "../system/logger.ts";
import { AudioModeService, UnknownAudioModeError } from "./audioModeService.ts";
import {
  ChannelVolumeService,
  InvalidAudioVolumeError,
  UnknownAudioChannelError
} from "./channelVolumeService.ts";
import type { DictationMuteService } from "./dictationMuteService.ts";
import type { Updater } from "./updater.ts";

export class ControlServer {
  private static readonly dashboardHashes = new Set(["#home", "#audio", "#wallpapers"]);
  private readonly log: Logger;
  private readonly config: ControlConfig;
  private readonly updater: Updater;
  private readonly audioModes: AudioModeService;
  private readonly channelVolumes: ChannelVolumeService;
  private readonly dictationMute: DictationMuteService;
  private readonly logger: Logger;
  private app?: { stop: () => unknown };

  constructor(
    config: ControlConfig,
    updater: Updater,
    audioModes: AudioModeService,
    channelVolumes: ChannelVolumeService,
    dictationMute: DictationMuteService,
    logger: Logger
  ) {
    this.config = config;
    this.updater = updater;
    this.audioModes = audioModes;
    this.channelVolumes = channelVolumes;
    this.dictationMute = dictationMute;
    this.logger = logger;
    this.log = logger.child("control");
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Control API disabled");
      return;
    }

    this.app = new Elysia({ adapter: node() })
      .use(wallpaperRoutes(new WallpaperService(this.logger), this.logger))
      // Dashboard shell. Read per request so editing the page needs no restart; it is one small
      // file on localhost.
      .get("/", async () => {
        const path = join(import.meta.dirname, "..", "web", "dashboard.html");
        return new Response(await readFile(path, "utf8"), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      })
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
      .post(
        "/dashboard/open-browser",
        async ({ body, set }) => {
          try {
            await this.openDashboardInBrowser(body.hash);
            set.status = 202;
            return { accepted: true };
          } catch (error) {
            set.status = 500;
            this.log.error("Failed to open dashboard in browser", { error: String(error) });
            return { accepted: false, error: "Failed to open dashboard in browser" };
          }
        },
        {
          body: t.Object({
            hash: t.Optional(t.String())
          })
        }
      )
      .get("/dictation-mute", () => this.dictationMute.getStatus())
      .post(
        "/dictation-mute",
        async ({ body }) => {
          await this.dictationMute.setEnabled(body.enabled);
          return this.dictationMute.getStatus();
        },
        {
          body: t.Object({
            enabled: t.Boolean()
          })
        }
      )
      .get("/audio/modes", async () => ({
        modes: this.audioModes.listModes(),
        // The confirmed mode is persisted by the MQTT sync; reading the same file keeps the
        // dashboard honest without new plumbing.
        active: (await new FileAudioMqttStateStore().load()).mode ?? null
      }))
      .get("/audio/volumes", () => ({
        channels: this.channelVolumes.listStates().map((state) => ({
          name: state.channelName,
          volumePercent: state.endpoint.volumePercent,
          muted: state.muted
        }))
      }))
      .ws("/audio/volumes/ws", {
        parse: (_ws, message) =>
          typeof message === "string"
            ? (JSON.parse(message) as {
                channel: string;
                volumePercent: number;
                sequence: number;
              })
            : (message as { channel: string; volumePercent: number; sequence: number }),
        body: t.Object({
          channel: t.String(),
          volumePercent: t.Integer({ minimum: 0, maximum: 100 }),
          sequence: t.Integer({ minimum: 0 })
        }),
        message: async (ws, message) => {
          try {
            await this.channelVolumes.setVolume(message.channel, message.volumePercent);
            ws.send(
              JSON.stringify({
                type: "volume-applied",
                channel: message.channel,
                volumePercent: message.volumePercent,
                sequence: message.sequence
              })
            );
          } catch (error) {
            this.log.error("Failed to set streamed audio channel volume", {
              channel: message.channel,
              error: String(error)
            });
            ws.send(
              JSON.stringify({
                type: "volume-error",
                channel: message.channel,
                sequence: message.sequence,
                error:
                  error instanceof UnknownAudioChannelError ||
                  error instanceof InvalidAudioVolumeError
                    ? error.message
                    : "Failed to set audio channel volume"
              })
            );
          }
        }
      })
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

  private async openDashboardInBrowser(hash?: string): Promise<void> {
    const url = new URL(`http://${this.config.host}:${this.config.port}/`);
    const safeHash = hash && ControlServer.dashboardHashes.has(hash) ? hash : "#home";
    url.hash = safeHash;
    await launchDetached("cmd.exe", ["/c", "start", "", url.toString()], {
      windowsHide: true
    });
  }
}
