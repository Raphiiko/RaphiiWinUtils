import type { AppConfig } from "../config/schema.ts";
import { CompositeAudioModePublisher } from "../homeAssistant/compositeAudioModePublisher.ts";
import { HomeAssistantAudioSyncService } from "../homeAssistant/homeAssistantAudioSync.ts";
import { HomeAssistantAudioModeWebhook } from "../homeAssistant/audioModeWebhook.ts";
import { ClipboardAutomationService } from "../service/clipboardAutomationService.ts";
import { AudioModeService } from "../service/audioModeService.ts";
import { ChannelVolumeService } from "../service/channelVolumeService.ts";
import { ControlServer } from "../service/controlServer.ts";
import { Updater } from "../service/updater.ts";
import { XsOverlayRecoveryService } from "../service/xsOverlayRecoveryService.ts";
import { Logger } from "../system/logger.ts";
import type { Notifier } from "../system/notify.ts";
import type { AppModule } from "./appModule.ts";

export function createServiceModules(
  config: AppConfig,
  notifier: Notifier,
  logger: Logger
): AppModule[] {
  const updater = new Updater(config.updater, notifier, logger);
  const channelVolumeService = new ChannelVolumeService(config, logger);
  const legacyAudioModeWebhook = new HomeAssistantAudioModeWebhook(config.homeAssistant);
  const audioModeService = new AudioModeService(config, logger, legacyAudioModeWebhook);
  const homeAssistantAudioSync = new HomeAssistantAudioSyncService(
    config.homeAssistant,
    audioModeService,
    channelVolumeService,
    logger,
    undefined,
    undefined,
    {
      clipboardAutomationEnabled: config.clipboard.enabled,
      xsOverlayRecoveryEnabled: config.xsOverlayRecovery.enabled,
      updaterEnabled: config.updater.enabled,
      localControlApiEnabled: config.control.enabled
    }
  );
  audioModeService.setPublisher(
    new CompositeAudioModePublisher([homeAssistantAudioSync, legacyAudioModeWebhook])
  );
  const controlServer = new ControlServer(
    config.control,
    updater,
    audioModeService,
    channelVolumeService,
    logger
  );
  const clipboardAutomationService = new ClipboardAutomationService(config.clipboard, logger);
  const xsOverlayRecoveryService = new XsOverlayRecoveryService(
    config.xsOverlayRecovery,
    notifier,
    logger
  );

  return [
    serviceModule("updater", updater),
    serviceModule("channel-volume", channelVolumeService),
    serviceModule("audio-control", {
      start: () => {
        controlServer.start();
        homeAssistantAudioSync.start();
      },
      stop: () => {
        controlServer.stop();
        homeAssistantAudioSync.stop();
        audioModeService.stop();
      }
    }),
    serviceModule("clipboard-automations", clipboardAutomationService),
    serviceModule("xsoverlay-recovery", xsOverlayRecoveryService)
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
