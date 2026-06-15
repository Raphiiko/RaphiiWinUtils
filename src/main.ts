import { loadConfig } from "./config/loadConfig";
import { Logger } from "./system/logger";
import { Notifier } from "./system/notify";
import { AudioModeService } from "./service/audioModeService";
import { ChannelVolumeService } from "./service/channelVolumeService";
import { ControlServer } from "./service/controlServer";
import { notifyCompletedUpdateIfNeeded, Updater } from "./service/updater";
import { installLocal } from "./service/installer";

const logger = new Logger("raphii-win-utils");

async function main(): Promise<void> {
  const config = await loadConfig();
  const notifier = new Notifier(config.notifications, logger);
  const command = process.argv[2] ?? "run";

  if (command === "install") {
    await installLocal(config, logger);
    return;
  }

  if (command !== "run") {
    logger.error("Unknown command", { command });
    process.exitCode = 1;
    return;
  }

  logger.info("Service starting");
  notifyCompletedUpdateIfNeeded(config.updater, notifier, logger);

  const updater = new Updater(config.updater, notifier, logger);
  updater.start();

  const service = new ChannelVolumeService(config, logger);
  service.start();

  const audioModeService = new AudioModeService(config, logger);
  const controlServer = new ControlServer(config.control, updater, audioModeService, logger);
  controlServer.start();

  const stop = () => {
    logger.info("Service stopping");
    controlServer.stop();
    audioModeService.stop();
    service.stop();
    updater.stop();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  logger.error("Fatal startup failure", { error: String(error) });
  process.exitCode = 1;
});
