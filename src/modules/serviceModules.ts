import type { AppConfig } from "../config/schema.ts";
import { MqttAudioSyncService } from "../mqtt/mqttAudioSync.ts";
import { ClipboardAutomationService } from "../service/clipboardAutomationService.ts";
import { AudioModeService } from "../service/audioModeService.ts";
import { ChannelVolumeService } from "../service/channelVolumeService.ts";
import { ControlServer } from "../service/controlServer.ts";
import { DictationMuteService } from "../service/dictationMuteService.ts";
import { TrayApplication } from "../service/trayApplication.ts";
import { Updater } from "../service/updater.ts";
import { XsOverlayRecoveryService } from "../service/xsOverlayRecoveryService.ts";
import { VrChatRecoveryService } from "../service/vrChatRecoveryService.ts";
import { Logger } from "../system/logger.ts";
import type { Notifier } from "../system/notify.ts";
import type { AppModule } from "./appModule.ts";

export function createServiceModules(
  config: AppConfig,
  notifier: Notifier,
  logger: Logger
): AppModule[] {
  const updater = new Updater(config.updater, config.notifications.appName, notifier, logger);
  const channelVolumeService = new ChannelVolumeService(config, logger);
  const audioModeService = new AudioModeService(
    config,
    logger,
    { publishMode: async () => {} },
    {
      filterPreOutputVolumePolicies: (policies) =>
        channelVolumeService.policiesThatNeedApply(policies)
    }
  );
  const vrChatRecoveryService = new VrChatRecoveryService(config, logger);
  const mqttAudioSync = new MqttAudioSyncService(
    config.mqtt,
    audioModeService,
    channelVolumeService,
    logger,
    {},
    vrChatRecoveryService
  );
  audioModeService.setPublisher(mqttAudioSync);
  const dictationMuteService = new DictationMuteService(config.dictationMute, logger);
  const controlServer = new ControlServer(
    config.control,
    updater,
    audioModeService,
    channelVolumeService,
    dictationMuteService,
    logger
  );
  const trayApplication = new TrayApplication(config.control, logger);
  const clipboardAutomationService = new ClipboardAutomationService(config.clipboard, logger);
  const xsOverlayRecoveryService = new XsOverlayRecoveryService(
    config.xsOverlayRecovery,
    notifier,
    logger
  );

  return [
    serviceModule("updater", updater),
    serviceModule("channel-volume", channelVolumeService),
    serviceModule("vr-recovery", vrChatRecoveryService),
    serviceModule("audio-control", {
      start: () => {
        controlServer.start();
        mqttAudioSync.start();
      },
      stop: () => {
        controlServer.stop();
        mqttAudioSync.stop();
        audioModeService.stop();
      }
    }),
    serviceModule("tray", trayApplication),
    serviceModule("clipboard-automations", clipboardAutomationService),
    serviceModule("dictation-mute", dictationMuteService),
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
