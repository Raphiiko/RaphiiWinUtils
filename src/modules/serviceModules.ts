import type { AppConfig } from "../config/schema";
import { ClipboardAutomationService } from "../service/clipboardAutomationService";
import { AudioModeService } from "../service/audioModeService";
import { ChannelVolumeService } from "../service/channelVolumeService";
import { ControlServer } from "../service/controlServer";
import { Updater } from "../service/updater";
import { Logger } from "../system/logger";
import type { Notifier } from "../system/notify";
import type { AppModule } from "./appModule";

export function createServiceModules(
  config: AppConfig,
  notifier: Notifier,
  logger: Logger
): AppModule[] {
  const updater = new Updater(config.updater, notifier, logger);
  const channelVolumeService = new ChannelVolumeService(config, logger);
  const audioModeService = new AudioModeService(config, logger);
  const controlServer = new ControlServer(config.control, updater, audioModeService, logger);
  const clipboardAutomationService = new ClipboardAutomationService(config.clipboard, logger);

  return [
    serviceModule("updater", updater),
    serviceModule("channel-volume", channelVolumeService),
    serviceModule("audio-control", {
      start: () => controlServer.start(),
      stop: () => {
        controlServer.stop();
        audioModeService.stop();
      }
    }),
    serviceModule("clipboard-automations", clipboardAutomationService)
  ];
}

function serviceModule(
  name: string,
  service: { start(): void | Promise<void>; stop(): void | Promise<void> }
): AppModule {
  return {
    name,
    start: () => service.start(),
    stop: () => service.stop()
  };
}
