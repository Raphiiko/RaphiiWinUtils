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

interface RecoveryOperation {
  operationId: string;
  action: VrRecoveryAction;
  controller: AbortController;
  watchdog?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
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
  private active?: RecoveryOperation;
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
      if (this.status.phase === "awaiting-rwu-after-boot" && saved.operationId)
        this.beginOperation(saved.operationId, "hard-recover");
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

  startVrChat(operationId?: string): Promise<VrChatRecoveryRequestResult> {
    return this.requestLocal("start", operationId);
  }

  recoverLastInstance(operationId?: string): Promise<VrChatRecoveryRequestResult> {
    return this.requestLocal("soft-recover", operationId);
  }

  hardRecover(
    operationId = this.dependencies.createOperationId(),
    beforeReboot?: () => Promise<void>
  ): Promise<VrChatRecoveryRequestResult> {
    if (!this.config.hardRecovery.enabled) {
      return Promise.resolve({ accepted: false, reason: "hard recovery is disabled" });
    }
    if (this.isSameOperation(operationId))
      return Promise.resolve({ accepted: true, operationId });
    const recovery = this.beginOperation(operationId, "hard-recover");
    this.run(recovery, () => this.runHardRecoveryPreparation(recovery, beforeReboot));
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
    if (!this.active) this.restoreOperation(operationId, "hard-recover");
    const recovery = this.active;
    if (!recovery || recovery.operationId !== operationId)
      return Promise.resolve({ accepted: false, reason: "recovery is already active" });
    if (recovery.running) return Promise.resolve(this.rejectedBusyResult());
    this.run(recovery, () => this.runHardRecoveryResume(recovery));
    return Promise.resolve({ accepted: true, operationId });
  }

  cancel(operationId?: string, reason?: string): Promise<VrChatRecoveryRequestResult> {
    if (operationId && operationId !== this.active?.operationId) {
      return Promise.resolve({ accepted: false, reason: "operation ID does not match the running recovery" });
    }
    const cancelledOperationId = this.active?.operationId;
    this.abortActive();
    return this.setStatus({
      phase: reason ? "failed-needs-attention" : "idle",
      reason: reason || undefined
    }).then(() => ({ accepted: true, operationId: cancelledOperationId }));
  }

  cancelHardRecovery(operationId: string, reason: string): Promise<VrChatRecoveryRequestResult> {
    return this.cancel(operationId, reason);
  }

  private async requestLocal(
    action: "start" | "soft-recover",
    operationId = this.dependencies.createOperationId()
  ): Promise<VrChatRecoveryRequestResult> {
    if (!this.config.vrChatRecovery.enabled) {
      return { accepted: false, reason: "VR recovery is disabled" };
    }
    if (this.isSameOperation(operationId)) return { accepted: true, operationId };
    const recovery = this.beginOperation(operationId, action);
    const running = this.run(recovery, () => this.runLocalRecovery(recovery));
    try {
      await running;
      return recovery.controller.signal.aborted
        ? { accepted: false, operationId, reason: "recovery was superseded or cancelled" }
        : { accepted: true, operationId };
    } catch (error) {
      return { accepted: false, operationId, reason: formatError(error) };
    }
  }

  private async runLocalRecovery(recovery: RecoveryOperation): Promise<void> {
    const { action, operationId } = recovery;
    await this.setStatus({
      operationId,
      action,
      phase: action === "start" ? "starting" : "soft-recovering",
      instanceId: undefined,
      reason: undefined,
      attempt: undefined,
      bootMarker: undefined
    }, recovery);
    this.throwIfAborted(recovery);
    const instanceId =
      action === "soft-recover" ? await this.captureLastInstanceId(recovery) : undefined;
    await this.setStatus({ instanceId }, recovery);
    try {
      await this.stopVrStack(recovery);
      const rejoined = await this.startVrStack(recovery, instanceId);
      await this.setStatus({
        ...completionStatus(instanceId, rejoined, action),
        instanceId
      }, recovery);
    } catch (error) {
      if (isAbortError(error)) return;
      await this.fail(formatError(error), recovery);
      throw error;
    }
  }

  private async runHardRecoveryPreparation(
    recovery: RecoveryOperation,
    beforeReboot?: () => Promise<void>
  ): Promise<void> {
    const { operationId } = recovery;
    await this.setStatus({ operationId, action: "hard-recover", phase: "preparing" }, recovery);
    const instanceId = await this.captureLastInstanceId(recovery);
    await this.setStatus({ instanceId }, recovery);
    try {
      await this.stopVrStack(recovery);
      await this.setStatus({
        phase: "reboot-commanded",
        bootMarker: await this.awaitExternal(this.dependencies.getBootMarker(), recovery)
      }, recovery);
      this.throwIfAborted(recovery);
      if (beforeReboot) await this.awaitExternal(beforeReboot(), recovery);
      this.throwIfAborted(recovery);
      this.log.warn("Requesting forced Windows reboot for hard recovery", { operationId });
      await this.awaitExternal(this.dependencies.requestReboot(), recovery);
    } catch (error) {
      if (isAbortError(error)) return;
      await this.fail(formatError(error), recovery);
    }
  }

  private async runHardRecoveryResume(recovery: RecoveryOperation): Promise<void> {
    const { operationId } = recovery;
    try {
      await this.sleep(this.config.hardRecovery.desktopSettleMs, recovery);
      await this.waitForMatrix(recovery);
      const rejoined = await this.startVrStack(recovery, this.status.instanceId);
      await this.setStatus(completionStatus(this.status.instanceId, rejoined, "hard-recover"), recovery);
    } catch (error) {
      if (isAbortError(error)) return;
      await this.fail(formatError(error), recovery);
      this.log.error("Hard recovery stopped and needs attention", {
        operationId,
        error: formatError(error)
      });
    }
  }

  private async waitForMatrix(recovery: RecoveryOperation): Promise<void> {
    await this.setStatus({ phase: "waiting-for-matrix" }, recovery);
    const ready = await this.waitFor(
      () => this.dependencies.isMatrixReady(),
      this.config.hardRecovery.matrixReadyTimeoutMs,
      this.config.hardRecovery.matrixReadyRetryDelayMs,
      recovery
    );
    if (!ready) throw new Error("Matrix Coconut did not answer a VBAN-TEXT health query in time");
  }

  private async ensureSteamReady(recovery: RecoveryOperation): Promise<void> {
    await this.setStatus({ phase: "waiting-for-steam" }, recovery);
    if (!(await this.isRunning("steam", recovery))) {
      await this.awaitExternal(
        this.dependencies.launchSteamClient(this.config.vrChatRecovery.steamPath),
        recovery
      );
    }
    const ready = await this.waitFor(
      () => this.isRunning("steam", recovery),
      this.config.vrStackStartup.steamReadyTimeoutMs,
      this.config.vrStackStartup.retryDelayMs,
      recovery
    );
    if (!ready) throw new Error("Steam did not become ready in time");
  }

  private async startSteamVrWithRetry(recovery: RecoveryOperation): Promise<void> {
    await this.setStatus({ phase: "waiting-for-steamvr" }, recovery);
    const ready = await this.launchWithRetry(
      "SteamVR",
      async () =>
        this.awaitExternal(
          this.dependencies.launchSteamApp(
            this.config.vrChatRecovery.steamPath,
            this.config.vrChatRecovery.steamVrAppId
          ),
          recovery
        ),
      async () =>
        (await this.isRunning("vrmonitor", recovery)) &&
        (await this.isRunning("vrserver", recovery)),
      async () => this.awaitExternal(this.dependencies.stopProcesses(["vrmonitor", "vrserver"]), recovery),
      this.config.vrStackStartup.steamVrReadyTimeoutMs,
      recovery
    );
    if (!ready) throw new Error("SteamVR did not become ready in time");
  }

  private async startOyasumiWithRetry(recovery: RecoveryOperation): Promise<void> {
    await this.setStatus({ phase: "waiting-for-oyasumi" }, recovery);
    if (await this.isRunning("oyasumivr", recovery)) return;
    const ready = await this.launchWithRetry(
      "OyasumiVR",
      async () =>
        this.awaitExternal(
          this.dependencies.launchSteamApp(
            this.config.vrChatRecovery.steamPath,
            this.config.vrChatRecovery.oyasumiVrAppId
          ),
          recovery
        ),
      async () => this.isRunning("oyasumivr", recovery),
      async () => this.awaitExternal(this.dependencies.stopProcesses(["OyasumiVR"]), recovery),
      this.config.vrStackStartup.oyasumiReadyTimeoutMs,
      recovery
    );
    if (!ready) throw new Error("OyasumiVR did not become ready in time");
  }

  private async startVrChatAndVerifyRejoin(
    recovery: RecoveryOperation,
    instanceId: string | undefined
  ): Promise<boolean | undefined> {
    await this.setStatus({ phase: "launching-vrchat" }, recovery);
    const args = instanceId ? [toVrChatLaunchUrl(instanceId)] : undefined;
    const launchStartedAtMs = this.dependencies.now().getTime();
    await this.awaitExternal(
      this.dependencies.launchSteamApp(
        this.config.vrChatRecovery.steamPath,
        this.config.vrChatRecovery.vrChatAppId,
        args
      ),
      recovery
    );

    const started = await this.waitFor(
      () => this.isRunning("vrchat", recovery),
      this.config.vrStackStartup.vrChatJoinTimeoutMs,
      this.config.vrStackStartup.retryDelayMs,
      recovery
    );
    if (!started) throw new Error("VRChat did not start in time");
    if (!instanceId) return undefined;

    await this.setStatus({ phase: "verifying-rejoin" }, recovery);
    return this.waitFor(
      () => this.dependencies.hasJoinedInstanceSince(instanceId, launchStartedAtMs),
      this.config.vrStackStartup.vrChatJoinTimeoutMs,
      this.config.vrStackStartup.retryDelayMs,
      recovery
    );
  }

  private async startVrStack(
    recovery: RecoveryOperation,
    instanceId: string | undefined
  ): Promise<boolean | undefined> {
    await this.ensureSteamReady(recovery);
    const steamVr = this.startSteamVrWithRetry(recovery);
    const oyasumi = this.startOyasumiWithRetry(recovery)
      .then((): undefined => undefined)
      .catch((error: unknown): unknown => error);
    await steamVr;
    const rejoined = await this.startVrChatAndVerifyRejoin(recovery, instanceId);
    const oyasumiError = await oyasumi;
    if (oyasumiError) throw asError(oyasumiError);
    return rejoined;
  }

  private async stopVrStack(recovery: RecoveryOperation): Promise<void> {
    await this.awaitExternal(
      this.dependencies.stopProcesses(["VRChat", "OyasumiVR", "vrmonitor", "vrserver"]),
      recovery
    );
    await this.sleep(
      Math.max(
        this.config.vrChatRecovery.vrChatExitWaitMs,
        this.config.vrChatRecovery.steamVrExitWaitMs
      ),
      recovery
    );
  }

  private async launchWithRetry(
    stage: string,
    launch: () => Promise<void>,
    isReady: () => Promise<boolean>,
    cleanup: () => Promise<void>,
    timeoutMs: number,
    recovery: RecoveryOperation
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.config.vrStackStartup.maxLaunchAttempts; attempt += 1) {
      this.throwIfAborted(recovery);
      await this.setStatus({ attempt }, recovery);
      await launch();
      if (await this.waitFor(isReady, timeoutMs, this.config.vrStackStartup.retryDelayMs, recovery))
        return true;
      if (attempt < this.config.vrStackStartup.maxLaunchAttempts) {
        this.log.warn(`${stage} launch attempt failed; retrying`, { attempt });
        await cleanup();
        await this.sleep(this.config.vrStackStartup.retryDelayMs, recovery);
      }
    }
    return false;
  }

  private async waitFor(
    check: () => Promise<boolean>,
    timeoutMs: number,
    retryDelayMs: number,
    recovery: RecoveryOperation
  ): Promise<boolean> {
    const deadline = this.dependencies.now().getTime() + timeoutMs;
    while (this.dependencies.now().getTime() <= deadline) {
      this.throwIfAborted(recovery);
      try {
        if (await this.awaitExternal(check(), recovery)) return true;
      } catch (error) {
        if (isAbortError(error)) throw error;
        this.log.warn("Recovery readiness check failed; will retry", { error: formatError(error) });
      }
      await this.sleep(retryDelayMs, recovery);
    }
    return false;
  }

  private async captureLastInstanceId(recovery: RecoveryOperation): Promise<string | undefined> {
    try {
      const instanceId = await this.awaitExternal(this.dependencies.findLastInstanceId(), recovery);
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

  private async isRunning(processName: string, recovery: RecoveryOperation): Promise<boolean> {
    return (await this.awaitExternal(this.dependencies.getRunningProcessNames([processName]), recovery)).has(
      processName.toLowerCase()
    );
  }

  private beginOperation(operationId: string, action: VrRecoveryAction): RecoveryOperation {
    this.abortActive();
    const recovery = this.restoreOperation(operationId, action);
    recovery.watchdog = setTimeout(() => {
      if (this.active !== recovery || recovery.controller.signal.aborted) return;
      const phase = this.status.phase;
      recovery.controller.abort();
      void this.setStatus(
        { phase: "failed-needs-attention", reason: `watchdog timeout at ${phase}` },
        recovery
      ).finally(() => {
        if (this.active === recovery) this.active = undefined;
      });
    }, this.watchdogTimeoutMs(action));
    return recovery;
  }

  private restoreOperation(operationId: string, action: VrRecoveryAction): RecoveryOperation {
    const recovery = { operationId, action, controller: new AbortController() };
    this.active = recovery;
    return recovery;
  }

  private run(recovery: RecoveryOperation, task: () => Promise<void>): Promise<void> {
    const running = task();
    recovery.running = running;
    void running
      .catch((error) => {
        if (!isAbortError(error))
          this.log.error("VR recovery stopped unexpectedly", { error: formatError(error) });
      })
      .finally(() => {
        if (recovery.running === running) recovery.running = undefined;
      });
    return running;
  }

  private abortActive(): void {
    const recovery = this.active;
    if (!recovery) return;
    recovery.controller.abort();
    if (recovery.watchdog) clearTimeout(recovery.watchdog);
    this.active = undefined;
  }

  private isSameOperation(operationId: string): boolean {
    return this.active?.operationId === operationId || this.status.operationId === operationId;
  }

  private rejectedBusyResult(): VrChatRecoveryRequestResult {
    return {
      accepted: false,
      operationId: this.status.operationId,
      reason: `recovery is already active (${this.status.phase})`
    };
  }

  private watchdogTimeoutMs(action: VrRecoveryAction): number {
    if (action === "start") return this.config.vrChatRecovery.startWatchdogTimeoutMs;
    if (action === "soft-recover") return this.config.vrChatRecovery.softRecoveryWatchdogTimeoutMs;
    return this.config.hardRecovery.watchdogTimeoutMs;
  }

  private throwIfAborted(recovery: RecoveryOperation): void {
    if (recovery.controller.signal.aborted || this.active !== recovery)
      throw new Error("Recovery operation aborted");
  }

  private async awaitExternal<T>(promise: Promise<T>, recovery: RecoveryOperation): Promise<T> {
    this.throwIfAborted(recovery);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("Recovery operation aborted"));
      recovery.controller.signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
        (value) => {
          recovery.controller.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          recovery.controller.signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  private sleep(ms: number, recovery: RecoveryOperation): Promise<void> {
    return this.awaitExternal(this.dependencies.sleep(ms), recovery);
  }

  private async fail(reason: string, recovery?: RecoveryOperation): Promise<void> {
    await this.setStatus({ phase: "failed-needs-attention", reason }, recovery);
  }

  private async setStatus(
    change: Partial<VrRecoveryStatus>,
    recovery?: RecoveryOperation
  ): Promise<void> {
    if (recovery && this.active !== recovery) return;
    this.status = { ...this.status, ...change, updatedAt: this.dependencies.now().toISOString() };
    if (this.status.phase !== "failed-needs-attention") delete this.status.reason;
    if (isTerminalPhase(this.status.phase) && recovery?.watchdog) {
      clearTimeout(recovery.watchdog);
      recovery.watchdog = undefined;
    }
    this.notifyStatus();
    if (this.status.action === "hard-recover") {
      try {
        const save = this.dependencies.saveStatus(this.status);
        if (recovery) await this.awaitExternal(save, recovery);
        else await withTimeout(save, 10_000, "Hard recovery journal save timed out");
      } catch (error) {
        if (recovery && this.active !== recovery) return;
        if (isAbortError(error) && this.status.phase === "failed-needs-attention") return;
        this.status = {
          ...this.status,
          phase: "failed-needs-attention",
          updatedAt: this.dependencies.now().toISOString(),
          reason: `Could not save hard recovery journal: ${formatError(error)}`
        };
        this.log.error("Could not save hard recovery journal", { error: formatError(error) });
        this.notifyStatus();
      }
    }
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener(this.status);
    this.log.info("VR recovery status changed", this.status);
  }
}

function completionStatus(
  instanceId: string | undefined,
  rejoined: boolean | undefined,
  _action: VrRecoveryAction
): Pick<VrRecoveryStatus, "phase" | "reason"> {
  if (!instanceId) {
    return { phase: "completed-with-warning", reason: undefined };
  }
  return rejoined
    ? { phase: "completed", reason: undefined }
    : { phase: "completed-with-warning", reason: undefined };
}

function isActiveHardRecoveryPhase(phase: VrRecoveryPhase): boolean {
  return !isTerminalPhase(phase);
}

function isTerminalPhase(phase: VrRecoveryPhase): boolean {
  return ["idle", "completed", "completed-with-warning", "failed-needs-attention"].includes(phase);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === "Recovery operation aborted";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
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
