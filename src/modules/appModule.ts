import { Logger } from "../system/logger.ts";

export interface AppModule {
  name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export async function startModules(modules: AppModule[], logger: Logger): Promise<void> {
  const log = logger.child("modules");
  for (const module of modules) {
    await module.start();
    log.info("Module started", { module: module.name });
  }
}

export async function stopModules(modules: AppModule[], logger: Logger): Promise<void> {
  const log = logger.child("modules");
  for (const module of [...modules].reverse()) {
    try {
      await module.stop();
      log.info("Module stopped", { module: module.name });
    } catch (error) {
      log.warn("Module stop failed", { module: module.name, error: String(error) });
    }
  }
}
