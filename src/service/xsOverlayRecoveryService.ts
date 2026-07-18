import type { XsOverlayRecoveryConfig } from "../config/schema.ts";
import { Logger } from "../system/logger.ts";
import type { Notifier } from "../system/notify.ts";
import { requireSuccess } from "../system/process.ts";
import { getRunningProcessNames } from "../system/runningProcesses.ts";
import {
  createXsOverlayRecoveryState,
  observeXsOverlayProcesses,
  recordXsOverlayLaunch,
  type XsOverlayProcessSnapshot,
  type XsOverlayRecoveryState
} from "./xsOverlayRecoveryPolicy.ts";

interface XsOverlayRecoveryDependencies {
  probeProcesses(): Promise<XsOverlayProcessSnapshot>;
  launchSteamApp(steamPath: string, steamAppId: string): Promise<void>;
  now(): number;
}

export class XsOverlayRecoveryService {
  private readonly config: XsOverlayRecoveryConfig;
  private readonly log: Logger;
  private readonly notifier: Notifier;
  private readonly dependencies: XsOverlayRecoveryDependencies;
  private state: XsOverlayRecoveryState = createXsOverlayRecoveryState();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private checking = false;
  private lastCheckError?: string;
  private lastCheckErrorAtMs?: number;

  constructor(
    config: XsOverlayRecoveryConfig,
    notifier: Notifier,
    logger: Logger,
    dependencies: XsOverlayRecoveryDependencies = defaultDependencies
  ) {
    this.config = config;
    this.notifier = notifier;
    this.log = logger.child("xsoverlay-recovery");
    this.dependencies = dependencies;
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("XSOverlay crash recovery disabled");
      return;
    }

    this.stopped = false;
    void this.checkOnce();
    this.timer = setInterval(() => void this.checkOnce(), Math.max(250, this.config.pollMs));
    this.log.info("XSOverlay crash recovery started", {
      pollMs: this.config.pollMs,
      steamAppId: this.config.steamAppId
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state = createXsOverlayRecoveryState();
  }

  private async checkOnce(): Promise<void> {
    if (this.stopped || this.checking) return;

    this.checking = true;
    try {
      const snapshot = await this.dependencies.probeProcesses();
      if (this.stopped) return;
      this.clearCheckFailure();

      const previous = this.state;
      const result = observeXsOverlayProcesses(
        previous,
        snapshot,
        this.config,
        this.dependencies.now()
      );
      this.state = result.state;

      if (!previous.armed && this.state.armed) {
        this.log.info("XSOverlay recovery armed for active SteamVR session");
      } else if (previous.armed && !this.state.armed) {
        this.log.info("SteamVR stopped; XSOverlay recovery disarmed");
      }

      if (
        previous.armed &&
        previous.missingSinceMs === undefined &&
        this.state.missingSinceMs !== undefined
      ) {
        this.log.warn("XSOverlay process disappeared; waiting to confirm crash", {
          missingConfirmationMs: this.config.missingConfirmationMs
        });
      } else if (previous.missingSinceMs !== undefined && snapshot.xsOverlayRunning) {
        this.log.info("XSOverlay process returned before or after recovery");
      }

      if (!previous.exhausted && this.state.exhausted) {
        this.log.error("XSOverlay recovery attempt budget exhausted", {
          maxLaunchAttempts: this.config.maxLaunchAttempts
        });
        this.notifier.send(
          "XSOverlay recovery paused",
          `XSOverlay did not return after ${this.config.maxLaunchAttempts} Steam launch attempts.`
        );
      }

      if (result.action === "launch") await this.launchXsOverlay();
    } catch (error) {
      this.logCheckFailure(String(error));
    } finally {
      this.checking = false;
    }
  }

  private logCheckFailure(error: string): void {
    const nowMs = this.dependencies.now();
    const shouldLog =
      this.lastCheckErrorAtMs === undefined ||
      nowMs - this.lastCheckErrorAtMs >= 60_000;
    this.lastCheckError = error;
    if (shouldLog) {
      this.lastCheckErrorAtMs = nowMs;
      this.log.warn("XSOverlay recovery check failed", { error });
    }
  }

  private clearCheckFailure(): void {
    if (this.lastCheckError) {
      this.log.info("XSOverlay recovery process checks resumed", {
        previousError: this.lastCheckError
      });
    }
    this.lastCheckError = undefined;
    this.lastCheckErrorAtMs = undefined;
  }

  private async launchXsOverlay(): Promise<void> {
    const latestSnapshot = await this.dependencies.probeProcesses();
    if (!latestSnapshot.steamVrRunning || latestSnapshot.xsOverlayRunning) {
      this.log.info("XSOverlay restart skipped because process state changed", latestSnapshot);
      return;
    }

    this.state = recordXsOverlayLaunch(this.state, this.config, this.dependencies.now());

    this.log.warn("XSOverlay missing while SteamVR is running; launching through Steam", {
      attempt: this.state.launchAttempts,
      steamAppId: this.config.steamAppId
    });

    try {
      await this.dependencies.launchSteamApp(this.config.steamPath, this.config.steamAppId);
    } catch (error) {
      this.log.error("Steam could not launch XSOverlay", { error: String(error) });
    }
  }
}

const defaultDependencies: XsOverlayRecoveryDependencies = {
  probeProcesses: probeProcesses,
  launchSteamApp: async (steamPath, steamAppId) => {
    await requireSuccess(steamPath, ["-applaunch", steamAppId], { timeoutMs: 15_000 });
  },
  now: () => Date.now()
};

async function probeProcesses(): Promise<XsOverlayProcessSnapshot> {
  const processNames = await getRunningProcessNames(["vrmonitor", "XSOverlay"]);
  return {
    steamVrRunning: processNames.has("vrmonitor"),
    xsOverlayRunning: processNames.has("xsoverlay")
  };
}
