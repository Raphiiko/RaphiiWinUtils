import { loadConfig } from "./config/loadConfig";
import { Logger } from "./system/logger";
import { Notifier } from "./system/notify";
import { ChannelVolumeService } from "./service/channelVolumeService";
import { ControlServer } from "./service/controlServer";
import { Updater } from "./service/updater";
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

  notifier.send("RaphiiWinUtils started", "Watching audio channel controls.");
  logger.info("Service starting");

  const updater = new Updater(config.updater, notifier, logger);
  updater.start();

  const service = new ChannelVolumeService(config, logger);
  service.start();

  const controlServer = new ControlServer(config.control, updater, logger);
  controlServer.start();

  const stop = () => {
    logger.info("Service stopping");
    controlServer.stop();
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
