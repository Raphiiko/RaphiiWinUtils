import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { VrChatRecoveryConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import { requireSuccess } from "../system/process.ts";
import { getRunningProcessNames, stopProcesses } from "../system/runningProcesses.ts";

export type VrChatRecoveryAction = "recover-last-instance" | "start";

export interface VrChatRecoveryRequestResult {
  accepted: boolean;
}

export interface VrChatRecoveryDependencies {
  findLastInstanceId(): Promise<string | undefined>;
  getRunningProcessNames(processNames: string[]): Promise<Set<string>>;
  stopProcesses(processNames: string[]): Promise<void>;
  launchSteamApp(steamPath: string, appId: string, args?: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export class VrChatRecoveryService {
  private readonly config: VrChatRecoveryConfig;
  private readonly dependencies: VrChatRecoveryDependencies;
  private readonly log: Logger;
  private running?: Promise<void>;

  constructor(
    config: VrChatRecoveryConfig,
    logger: Logger,
    dependencies: VrChatRecoveryDependencies = defaultDependencies
  ) {
    this.config = config;
    this.log = logger.child("vrchat-recovery");
    this.dependencies = dependencies;
  }

  recoverLastInstance(): Promise<VrChatRecoveryRequestResult> {
    return this.request("recover-last-instance");
  }

  startVrChat(): Promise<VrChatRecoveryRequestResult> {
    return this.request("start");
  }

  private async request(action: VrChatRecoveryAction): Promise<VrChatRecoveryRequestResult> {
    if (!this.config.enabled) {
      this.log.info("VRChat recovery request ignored because it is disabled", { action });
      return { accepted: false };
    }
    if (this.running) {
      this.log.warn("VRChat recovery request ignored because another action is running", {
        action
      });
      return { accepted: false };
    }

    const operation = this.run(action);
    this.running = operation;
    try {
      await operation;
      return { accepted: true };
    } finally {
      if (this.running === operation) this.running = undefined;
    }
  }

  private async run(action: VrChatRecoveryAction): Promise<void> {
    const lastInstanceId =
      action === "recover-last-instance" ? await this.findLastInstanceId() : undefined;

    const vrChatRunning = await this.isRunning("vrchat");
    if (vrChatRunning) {
      this.log.info("Stopping VRChat before launch", { action });
      await this.dependencies.stopProcesses(["VRChat"]);
      await this.dependencies.sleep(this.config.vrChatExitWaitMs);
    }

    const steamVrRunning = await this.isRunning("vrmonitor");
    if (steamVrRunning) {
      this.log.info("Stopping SteamVR before launch", { action });
      await this.dependencies.stopProcesses(["vrmonitor"]);
      await this.dependencies.sleep(this.config.steamVrExitWaitMs);
    }

    this.log.info("Starting SteamVR", { action, steamVrAppId: this.config.steamVrAppId });
    await this.dependencies.launchSteamApp(this.config.steamPath, this.config.steamVrAppId);
    await this.startOyasumiVrIfNeeded();
    await this.dependencies.sleep(this.config.steamVrStartWaitMs);

    const launchArgs = lastInstanceId ? [toVrChatLaunchUrl(lastInstanceId)] : undefined;
    this.log.info("Starting VRChat", {
      action,
      vrChatAppId: this.config.vrChatAppId,
      rejoiningLastInstance: Boolean(lastInstanceId)
    });
    await this.dependencies.launchSteamApp(
      this.config.steamPath,
      this.config.vrChatAppId,
      launchArgs
    );
  }

  private async isRunning(processName: string): Promise<boolean> {
    const processes = await this.dependencies.getRunningProcessNames([processName]);
    return processes.has(processName.toLowerCase());
  }

  private async startOyasumiVrIfNeeded(): Promise<void> {
    if (await this.isRunning("OyasumiVR")) {
      this.log.info("OyasumiVR is already running; skipping launch");
      return;
    }

    this.log.info("Starting OyasumiVR alongside SteamVR", {
      oyasumiVrAppId: this.config.oyasumiVrAppId
    });
    await this.dependencies.launchSteamApp(this.config.steamPath, this.config.oyasumiVrAppId);
  }

  private async findLastInstanceId(): Promise<string | undefined> {
    try {
      const instanceId = await this.dependencies.findLastInstanceId();
      if (!instanceId) this.log.warn("No last VRChat instance was found; launching normally");
      return instanceId;
    } catch (error) {
      this.log.warn("Could not read the last VRChat instance; launching normally", {
        error: formatError(error)
      });
      return undefined;
    }
  }
}

const defaultDependencies: VrChatRecoveryDependencies = {
  findLastInstanceId: findLastVrChatInstanceId,
  getRunningProcessNames,
  stopProcesses,
  launchSteamApp: async (steamPath, appId, args = []) => {
    await requireSuccess(steamPath, ["-applaunch", appId, ...args], { timeoutMs: 15_000 });
  },
  sleep: async (ms) => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
};

export async function findLastVrChatInstanceId(): Promise<string | undefined> {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return undefined;

  const logDirectory = join(userProfile, "AppData", "LocalLow", "VRChat", "VRChat");
  const entries = await readdir(logDirectory, { withFileTypes: true });
  const logs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^output_log_.*\.txt$/i.test(entry.name))
      .map(async (entry) => {
        const path = join(logDirectory, entry.name);
        return { path, modifiedAtMs: (await stat(path)).mtimeMs };
      })
  );
  const newestLog = findMostRecentVrChatLog(logs);
  if (!newestLog) return undefined;

  const log = await readFile(newestLog.path, "utf8");
  return findLastInstanceIdInLog(log);
}

export function findMostRecentVrChatLog(
  logs: Array<{ path: string; modifiedAtMs: number }>
): { path: string; modifiedAtMs: number } | undefined {
  return logs.reduce<{ path: string; modifiedAtMs: number } | undefined>(
    (newest, candidate) =>
      !newest || candidate.modifiedAtMs > newest.modifiedAtMs ? candidate : newest,
    undefined
  );
}

export function findLastInstanceIdInLog(log: string): string | undefined {
  const matches = [
    ...log.matchAll(
      /\[Behaviour\]\s+Joining(?:\s+or\s+Creating\s+Room:)?\s+(wrld_[0-9a-f-]+:[^\s"']+)/gi
    )
  ];
  return matches.at(-1)?.[1];
}

export function toVrChatLaunchUrl(instanceId: string): string {
  return `vrchat://launch?ref=vrchat.com&id=${instanceId}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
