import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config/schema.ts";
import { VbanTextClient } from "../matrix/vbanTextClient.ts";
import { Logger } from "../system/logger.ts";
import { launchDetached, requireSuccess, runCommand } from "../system/process.ts";
import { getRunningProcessNames, stopProcesses } from "../system/runningProcesses.ts";

export type VrRecoveryAction = "start" | "soft-recover" | "hard-recover";

export type VrRecoveryPhase =
  | "idle"
  | "starting"
  | "soft-recovering"
  | "preparing"
  | "reboot-commanded"
  | "awaiting-rwu-after-boot"
  | "waiting-for-matrix"
  | "waiting-for-steam"
  | "waiting-for-steamvr"
  | "waiting-for-oyasumi"
  | "launching-vrchat"
  | "verifying-rejoin"
  | "completed"
  | "completed-with-warning"
  | "failed-needs-attention";

export interface VrRecoveryStatus {
  operationId?: string;
  action?: VrRecoveryAction;
  phase: VrRecoveryPhase;
  updatedAt: string;
  attempt?: number;
  reason?: string;
  instanceId?: string;
  bootMarker?: string;
}

export interface VrChatRecoveryRequestResult {
  accepted: boolean;
  operationId?: string;
  reason?: string;
}

export interface VrChatRecoveryDependencies {
  findLastInstanceId(): Promise<string | undefined>;
  getRunningProcessNames(processNames: string[]): Promise<Set<string>>;
  stopProcesses(processNames: string[]): Promise<void>;
  launchSteamClient(steamPath: string): Promise<void>;
  launchSteamApp(steamPath: string, appId: string, args?: string[]): Promise<void>;
  isMatrixReady(): Promise<boolean>;
  hasJoinedInstanceSince(instanceId: string, sinceMs: number): Promise<boolean>;
  requestReboot(): Promise<void>;
  sleep(ms: number): Promise<void>;
  loadStatus(): Promise<VrRecoveryStatus | undefined>;
  saveStatus(status: VrRecoveryStatus): Promise<void>;
  createOperationId(): string;
  now(): Date;
  getBootMarker(): Promise<string>;
}

/**
 * The one local gate for every VR start/recovery path. Hard recovery is also
 * journaled so a reboot cannot leave the next process instance guessing.
 */
export class VrChatRecoveryService {
  private readonly config: AppConfig;
  private readonly dependencies: VrChatRecoveryDependencies;
  private readonly log: Logger;
  private status: VrRecoveryStatus = { phase: "idle", updatedAt: new Date(0).toISOString() };
  private running?: Promise<void>;
  private readonly statusListeners = new Set<(status: VrRecoveryStatus) => void>();

  constructor(
    config: AppConfig,
    logger: Logger,
    dependencies: Partial<VrChatRecoveryDependencies> = {}
  ) {
    this.config = config;
    this.log = logger.child("vr-recovery");
    this.dependencies = { ...createDefaultDependencies(config, logger), ...dependencies };
  }

  async start(): Promise<void> {
    let saved: VrRecoveryStatus | undefined;
    try {
      saved = await this.dependencies.loadStatus();
    } catch (error) {
      this.status = {
        phase: "failed-needs-attention",
        updatedAt: this.dependencies.now().toISOString(),
        reason: `Could not read hard recovery journal: ${formatError(error)}`
      };
      this.log.error("Could not read hard recovery journal", { error: formatError(error) });
      return;
    }
    if (!saved) return;

    this.status = saved;
    if (saved.action === "hard-recover" && isActiveHardRecoveryPhase(saved.phase)) {
      const bootMarker = await this.dependencies.getBootMarker();
      if (
        saved.phase === "reboot-commanded" &&
        saved.bootMarker &&
        saved.bootMarker !== bootMarker
      ) {
        await this.setStatus({ phase: "awaiting-rwu-after-boot" });
      } else {
        await this.fail("RaphiiWinUtils restarted without observing the requested Windows reboot");
      }
      this.log.warn("Hard recovery is awaiting Home Assistant resume", {
        operationId: saved.operationId,
        previousPhase: saved.phase
      });
    }
  }

  stop(): void {
    // Operations intentionally stop only at their own bounded checkpoints.
  }

  onStatusChange(listener: (status: VrRecoveryStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): VrRecoveryStatus {
    return this.status;
  }

  startVrChat(): Promise<VrChatRecoveryRequestResult> {
    return this.requestLocal("start");
  }

  recoverLastInstance(): Promise<VrChatRecoveryRequestResult> {
    return this.requestLocal("soft-recover");
  }

  hardRecover(
    operationId = this.dependencies.createOperationId(),
    beforeReboot?: () => Promise<void>
  ): Promise<VrChatRecoveryRequestResult> {
    if (!this.config.hardRecovery.enabled) {
      return Promise.resolve({ accepted: false, reason: "hard recovery is disabled" });
    }
    if (this.status.operationId === operationId)
      return Promise.resolve({ accepted: true, operationId });
    if (this.isBusy()) return Promise.resolve(this.rejectedBusyResult());
    const operation = this.runHardRecoveryPreparation(operationId, beforeReboot);
    this.running = operation;
    void operation.finally(() => {
      if (this.running === operation) this.running = undefined;
    });
    return Promise.resolve({ accepted: true, operationId });
  }

  resumeHardRecovery(operationId: string): Promise<VrChatRecoveryRequestResult> {
    if (!operationId || operationId !== this.status.operationId) {
      return Promise.resolve({
        accepted: false,
        reason: "operation ID does not match the pending recovery"
      });
    }
    if (this.status.action !== "hard-recover" || this.status.phase !== "awaiting-rwu-after-boot") {
      return Promise.resolve({
        accepted: false,
        reason: `recovery is not awaiting resume (${this.status.phase})`
      });
    }
    if (this.running) return Promise.resolve(this.rejectedBusyResult());

    const operation = this.runHardRecoveryResume(operationId);
    this.running = operation;
    void operation.finally(() => {
      if (this.running === operation) this.running = undefined;
    });
    return Promise.resolve({ accepted: true, operationId });
  }

  async cancelHardRecovery(
    operationId: string,
    reason: string
  ): Promise<VrChatRecoveryRequestResult> {
    if (
      !operationId ||
      operationId !== this.status.operationId ||
      this.status.action !== "hard-recover"
    ) {
      return { accepted: false, reason: "operation ID does not match the pending recovery" };
    }
    if (this.running)
      return { accepted: false, reason: "cannot cancel while a local recovery stage is running" };
    if (!isActiveHardRecoveryPhase(this.status.phase)) {
      return { accepted: false, reason: `recovery is already terminal (${this.status.phase})` };
    }
    await this.fail(reason || "Cancelled by the recovery owner");
    return { accepted: true, operationId };
  }

  private async requestLocal(
    action: "start" | "soft-recover"
  ): Promise<VrChatRecoveryRequestResult> {
    if (!this.config.vrChatRecovery.enabled) {
      return { accepted: false, reason: "VR recovery is disabled" };
    }
    if (this.isBusy()) return this.rejectedBusyResult();

    const operationId = this.dependencies.createOperationId();
    const operation = this.runLocalRecovery(action, operationId);
    this.running = operation;
    try {
      await operation;
      return { accepted: true, operationId };
    } catch (error) {
      return { accepted: false, operationId, reason: formatError(error) };
    } finally {
      if (this.running === operation) this.running = undefined;
    }
  }

  private async runLocalRecovery(
    action: "start" | "soft-recover",
    operationId: string
  ): Promise<void> {
    await this.setStatus({
      operationId,
      action,
      phase: action === "start" ? "starting" : "soft-recovering",
      instanceId: undefined,
      reason: undefined,
      attempt: undefined,
      bootMarker: undefined
    });
    const instanceId = action === "soft-recover" ? await this.captureLastInstanceId() : undefined;
    await this.setStatus({ instanceId });
    try {
      await this.stopVrStack();
      const rejoined = await this.startVrStack(instanceId);
      await this.setStatus({
        ...completionStatus(instanceId, rejoined, action),
        instanceId
      });
    } catch (error) {
      await this.fail(formatError(error));
      throw error;
    }
  }

  private async runHardRecoveryPreparation(
    operationId: string,
    beforeReboot?: () => Promise<void>
  ): Promise<void> {
    await this.setStatus({ operationId, action: "hard-recover", phase: "preparing" });
    const instanceId = await this.captureLastInstanceId();
    await this.setStatus({ instanceId });
    try {
      await this.stopVrStack();
      await this.setStatus({
        phase: "reboot-commanded",
        bootMarker: await this.dependencies.getBootMarker()
      });
      await beforeReboot?.();
      this.log.warn("Requesting forced Windows reboot for hard recovery", { operationId });
      await this.dependencies.requestReboot();
    } catch (error) {
      await this.fail(formatError(error));
    }
  }

  private async runHardRecoveryResume(operationId: string): Promise<void> {
    try {
      await this.dependencies.sleep(this.config.hardRecovery.desktopSettleMs);
      await this.waitForMatrix();
      const rejoined = await this.startVrStack(this.status.instanceId);
      await this.setStatus(completionStatus(this.status.instanceId, rejoined, "hard-recover"));
    } catch (error) {
      await this.fail(formatError(error));
      this.log.error("Hard recovery stopped and needs attention", {
        operationId,
        error: formatError(error)
      });
    }
  }

  private async waitForMatrix(): Promise<void> {
    await this.setStatus({ phase: "waiting-for-matrix" });
    const ready = await this.waitFor(
      () => this.dependencies.isMatrixReady(),
      this.config.hardRecovery.matrixReadyTimeoutMs,
      this.config.hardRecovery.matrixReadyRetryDelayMs
    );
    if (!ready) throw new Error("Matrix Coconut did not answer a VBAN-TEXT health query in time");
  }

  private async ensureSteamReady(): Promise<void> {
    await this.setStatus({ phase: "waiting-for-steam" });
    if (!(await this.isRunning("steam"))) {
      await this.dependencies.launchSteamClient(this.config.vrChatRecovery.steamPath);
    }
    const ready = await this.waitFor(
      () => this.isRunning("steam"),
      this.config.vrStackStartup.steamReadyTimeoutMs,
      this.config.vrStackStartup.retryDelayMs
    );
    if (!ready) throw new Error("Steam did not become ready in time");
  }

  private async startSteamVrWithRetry(): Promise<void> {
    await this.setStatus({ phase: "waiting-for-steamvr" });
    const ready = await this.launchWithRetry(
      "SteamVR",
      async () =>
        this.dependencies.launchSteamApp(
          this.config.vrChatRecovery.steamPath,
          this.config.vrChatRecovery.steamVrAppId
        ),
      async () => (await this.isRunning("vrmonitor")) && (await this.isRunning("vrserver")),
      async () => this.dependencies.stopProcesses(["vrmonitor", "vrserver"]),
      this.config.vrStackStartup.steamVrReadyTimeoutMs
    );
    if (!ready) throw new Error("SteamVR did not become ready in time");
  }

  private async startOyasumiWithRetry(): Promise<void> {
    await this.setStatus({ phase: "waiting-for-oyasumi" });
    if (await this.isRunning("oyasumivr")) return;
    const ready = await this.launchWithRetry(
      "OyasumiVR",
      async () =>
        this.dependencies.launchSteamApp(
          this.config.vrChatRecovery.steamPath,
          this.config.vrChatRecovery.oyasumiVrAppId
        ),
      async () => this.isRunning("oyasumivr"),
      async () => this.dependencies.stopProcesses(["OyasumiVR"]),
      this.config.vrStackStartup.oyasumiReadyTimeoutMs
    );
    if (!ready) throw new Error("OyasumiVR did not become ready in time");
  }

  private async startVrChatAndVerifyRejoin(
    instanceId: string | undefined
  ): Promise<boolean | undefined> {
    await this.setStatus({ phase: "launching-vrchat" });
    const args = instanceId ? [toVrChatLaunchUrl(instanceId)] : undefined;
    const launchStartedAtMs = this.dependencies.now().getTime();
    await this.dependencies.launchSteamApp(
      this.config.vrChatRecovery.steamPath,
      this.config.vrChatRecovery.vrChatAppId,
      args
    );

    const started = await this.waitFor(
      () => this.isRunning("vrchat"),
      this.config.vrStackStartup.vrChatJoinTimeoutMs,
      this.config.vrStackStartup.retryDelayMs
    );
    if (!started) throw new Error("VRChat did not start in time");
    if (!instanceId) return undefined;

    await this.setStatus({ phase: "verifying-rejoin" });
    return this.waitFor(
      () => this.dependencies.hasJoinedInstanceSince(instanceId, launchStartedAtMs),
      this.config.vrStackStartup.vrChatJoinTimeoutMs,
      this.config.vrStackStartup.retryDelayMs
    );
  }

  private async startVrStack(instanceId: string | undefined): Promise<boolean | undefined> {
    await this.ensureSteamReady();
    const steamVr = this.startSteamVrWithRetry();
    const oyasumi = this.startOyasumiWithRetry()
      .then((): undefined => undefined)
      .catch((error: unknown): unknown => error);
    await steamVr;
    const rejoined = await this.startVrChatAndVerifyRejoin(instanceId);
    const oyasumiError = await oyasumi;
    if (oyasumiError) throw asError(oyasumiError);
    return rejoined;
  }

  private async stopVrStack(): Promise<void> {
    await this.dependencies.stopProcesses(["VRChat", "OyasumiVR", "vrmonitor", "vrserver"]);
    await this.dependencies.sleep(
      Math.max(
        this.config.vrChatRecovery.vrChatExitWaitMs,
        this.config.vrChatRecovery.steamVrExitWaitMs
      )
    );
  }

  private async launchWithRetry(
    stage: string,
    launch: () => Promise<void>,
    isReady: () => Promise<boolean>,
    cleanup: () => Promise<void>,
    timeoutMs: number
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.config.vrStackStartup.maxLaunchAttempts; attempt += 1) {
      await this.setStatus({ attempt });
      await launch();
      if (await this.waitFor(isReady, timeoutMs, this.config.vrStackStartup.retryDelayMs))
        return true;
      if (attempt < this.config.vrStackStartup.maxLaunchAttempts) {
        this.log.warn(`${stage} launch attempt failed; retrying`, { attempt });
        await cleanup();
        await this.dependencies.sleep(this.config.vrStackStartup.retryDelayMs);
      }
    }
    return false;
  }

  private async waitFor(
    check: () => Promise<boolean>,
    timeoutMs: number,
    retryDelayMs: number
  ): Promise<boolean> {
    const deadline = this.dependencies.now().getTime() + timeoutMs;
    while (this.dependencies.now().getTime() <= deadline) {
      try {
        if (await check()) return true;
      } catch (error) {
        this.log.warn("Recovery readiness check failed; will retry", { error: formatError(error) });
      }
      await this.dependencies.sleep(retryDelayMs);
    }
    return false;
  }

  private async captureLastInstanceId(): Promise<string | undefined> {
    try {
      const instanceId = await this.dependencies.findLastInstanceId();
      if (!instanceId)
        this.log.warn("No last VRChat instance found; recovery will launch normally");
      return instanceId;
    } catch (error) {
      this.log.warn("Could not read last VRChat instance; recovery will launch normally", {
        error: formatError(error)
      });
      return undefined;
    }
  }

  private async isRunning(processName: string): Promise<boolean> {
    return (await this.dependencies.getRunningProcessNames([processName])).has(
      processName.toLowerCase()
    );
  }

  private isBusy(): boolean {
    return (
      Boolean(this.running) ||
      (this.status.action === "hard-recover" && isActiveHardRecoveryPhase(this.status.phase))
    );
  }

  private rejectedBusyResult(): VrChatRecoveryRequestResult {
    return {
      accepted: false,
      operationId: this.status.operationId,
      reason: `recovery is already active (${this.status.phase})`
    };
  }

  private async fail(reason: string): Promise<void> {
    await this.setStatus({ phase: "failed-needs-attention", reason });
  }

  private async setStatus(change: Partial<VrRecoveryStatus>): Promise<void> {
    this.status = { ...this.status, ...change, updatedAt: this.dependencies.now().toISOString() };
    if (this.status.action === "hard-recover") {
      try {
        await this.dependencies.saveStatus(this.status);
      } catch (error) {
        this.status = {
          ...this.status,
          phase: "failed-needs-attention",
          reason: `Could not save hard recovery journal: ${formatError(error)}`
        };
        this.log.error("Could not save hard recovery journal", { error: formatError(error) });
      }
    }
    for (const listener of this.statusListeners) listener(this.status);
    this.log.info("VR recovery status changed", this.status);
  }
}

function completionStatus(
  instanceId: string | undefined,
  rejoined: boolean | undefined,
  action: VrRecoveryAction
): Pick<VrRecoveryStatus, "phase" | "reason"> {
  if (!instanceId) {
    return {
      phase: "completed-with-warning",
      reason:
        action === "soft-recover" || action === "hard-recover"
          ? "No previous VRChat instance was found; launched normally"
          : undefined
    };
  }
  return rejoined
    ? { phase: "completed", reason: undefined }
    : {
        phase: "completed-with-warning",
        reason: "VRChat started but the requested instance rejoin was not observed"
      };
}

function isActiveHardRecoveryPhase(phase: VrRecoveryPhase): boolean {
  return !["idle", "completed", "completed-with-warning", "failed-needs-attention"].includes(phase);
}

function createDefaultDependencies(config: AppConfig, logger: Logger): VrChatRecoveryDependencies {
  return {
    findLastInstanceId: findLastVrChatInstanceId,
    getRunningProcessNames,
    stopProcesses,
    launchSteamClient: async (steamPath) => {
      // steam.exe stays resident, so don't await exit — just launch it and let
      // ensureSteamReady's isRunning("steam") poll be the readiness gate.
      await launchDetached(steamPath, []);
    },
    launchSteamApp: async (steamPath, appId, args = []) => {
      await requireSuccess(steamPath, ["-applaunch", appId, ...args], { timeoutMs: 15_000 });
    },
    isMatrixReady: async () => {
      const client = new VbanTextClient(config.matrix, logger);
      try {
        const responses = await client.request(
          `Slot(${config.audioModes.mainOutputSlot}).Device.WDM = ?;`,
          750
        );
        if (!responses.some((response) => response.includes(".Device.WDM"))) return false;
        const secondResponses = await client.request(
          `Slot(${config.audioModes.mainOutputSlot}).Device.WDM = ?;`,
          750
        );
        return secondResponses.some((response) => response.includes(".Device.WDM"));
      } finally {
        await client.close();
      }
    },
    hasJoinedInstanceSince: (instanceId, sinceMs) =>
      hasVrChatJoinedInstanceSince(instanceId, sinceMs),
    requestReboot: async () => {
      const result = await runCommand(
        "shutdown.exe",
        ["/r", "/f", "/t", "0", "/c", "RaphiiWinUtils SteamVR hard recovery"],
        { timeoutMs: 10_000 }
      );
      if (result.code !== 0)
        throw new Error(`Forced reboot request failed: ${result.stderr.trim() || result.code}`);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadStatus: () => loadHardRecoveryStatus(),
    saveStatus: (status) => saveHardRecoveryStatus(status),
    createOperationId: randomUUID,
    now: () => new Date(),
    getBootMarker: async () => {
      const result = await requireSuccess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks"
        ],
        { timeoutMs: 10_000 }
      );
      return result.stdout.trim();
    }
  };
}

function hardRecoveryStatusPath(): string {
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
  return join(appData, "RaphiiWinUtils", "hard-recovery-status.json");
}

async function loadHardRecoveryStatus(): Promise<VrRecoveryStatus | undefined> {
  try {
    return JSON.parse(await readFile(hardRecoveryStatusPath(), "utf8")) as VrRecoveryStatus;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function saveHardRecoveryStatus(status: VrRecoveryStatus): Promise<void> {
  const path = hardRecoveryStatusPath();
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(status)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function findLastVrChatInstanceId(): Promise<string | undefined> {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return undefined;
  const logDirectory = join(userProfile, "AppData", "LocalLow", "VRChat", "VRChat");
  const { readdir, stat } = await import("node:fs/promises");
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
  return findLastInstanceIdInLog(await readFile(newestLog.path, "utf8"));
}

export async function hasVrChatJoinedInstanceSince(
  instanceId: string,
  sinceMs: number
): Promise<boolean> {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return false;
  const logDirectory = join(userProfile, "AppData", "LocalLow", "VRChat", "VRChat");
  const { readdir, stat } = await import("node:fs/promises");
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
  if (!newestLog || newestLog.modifiedAtMs < sinceMs) return false;
  return findLastInstanceIdInLog(await readFile(newestLog.path, "utf8")) === instanceId;
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
  return [
    ...log.matchAll(
      /\[Behaviour\]\s+Joining(?:\s+or\s+Creating\s+Room:)?\s+(wrld_[0-9a-f-]+:[^\s"']+)/gi
    )
  ].at(-1)?.[1];
}

export function toVrChatLaunchUrl(instanceId: string): string {
  return `vrchat://launch?ref=vrchat.com&id=${instanceId}`;
}

function formatError(error: unknown): string {
  const normalized = asError(error);
  return `${normalized.name}: ${normalized.message}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
