import { loadConfig } from "./config/loadConfig.ts";
import { Logger } from "./system/logger.ts";
import { Notifier } from "./system/notify.ts";
import { notifyCompletedUpdateIfNeeded } from "./service/updater.ts";
import { installLocal } from "./service/installer.ts";
import { acquireSingleInstanceLock } from "./system/singleInstance.ts";
import { createServiceModules } from "./modules/serviceModules.ts";
import { startModules, stopModules } from "./modules/appModule.ts";

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

  const instanceLock = acquireSingleInstanceLock(logger);
  if (!instanceLock) return;

  logger.info("Service starting");
  notifyCompletedUpdateIfNeeded(config.updater, notifier, logger);

  const modules = createServiceModules(config, notifier, logger);
  await startModules(modules, logger);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("Service stopping");
    await stopModules(modules, logger);
    instanceLock.release();
    process.exit(0);
  };

  process.on("exit", () => instanceLock.release());
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((error) => {
  logger.error("Fatal startup failure", { error: String(error) });
  process.exitCode = 1;
});
