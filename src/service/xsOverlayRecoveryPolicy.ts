export interface XsOverlayRecoveryConfig {
  missingConfirmationMs: number;
  launchGraceMs: number;
  retryDelaysMs: number[];
  maxLaunchAttempts: number;
  healthyResetMs: number;
}

export interface XsOverlayProcessSnapshot {
  steamVrRunning: boolean;
  xsOverlayRunning: boolean;
}

export interface XsOverlayRecoveryState {
  armed: boolean;
  launchAttempts: number;
  healthySinceMs?: number;
  missingSinceMs?: number;
  nextLaunchAtMs?: number;
  exhausted: boolean;
}

export type XsOverlayRecoveryAction = "none" | "launch";

export function createXsOverlayRecoveryState(): XsOverlayRecoveryState {
  return {
    armed: false,
    launchAttempts: 0,
    exhausted: false
  };
}

export function observeXsOverlayProcesses(
  state: XsOverlayRecoveryState,
  snapshot: XsOverlayProcessSnapshot,
  config: XsOverlayRecoveryConfig,
  nowMs: number
): { state: XsOverlayRecoveryState; action: XsOverlayRecoveryAction } {
  if (!snapshot.steamVrRunning) {
    return { state: createXsOverlayRecoveryState(), action: "none" };
  }

  if (snapshot.xsOverlayRunning) {
    const healthySinceMs = state.healthySinceMs ?? nowMs;
    const stableForMs = nowMs - healthySinceMs;
    const resetBudget = stableForMs >= config.healthyResetMs;

    return {
      state: {
        armed: true,
        launchAttempts: resetBudget ? 0 : state.launchAttempts,
        healthySinceMs,
        exhausted: resetBudget ? false : state.exhausted
      },
      action: "none"
    };
  }

  if (!state.armed) return { state, action: "none" };

  const missingSinceMs = state.missingSinceMs ?? nowMs;
  if (nowMs - missingSinceMs < config.missingConfirmationMs) {
    return {
      state: { ...state, healthySinceMs: undefined, missingSinceMs },
      action: "none"
    };
  }

  if (state.exhausted || state.launchAttempts >= config.maxLaunchAttempts) {
    return {
      state: {
        ...state,
        healthySinceMs: undefined,
        missingSinceMs,
        exhausted: true
      },
      action: "none"
    };
  }

  if (state.nextLaunchAtMs !== undefined && nowMs < state.nextLaunchAtMs) {
    return {
      state: { ...state, healthySinceMs: undefined, missingSinceMs },
      action: "none"
    };
  }

  return {
    state: {
      ...state,
      healthySinceMs: undefined,
      missingSinceMs
    },
    action: "launch"
  };
}

export function recordXsOverlayLaunch(
  state: XsOverlayRecoveryState,
  config: XsOverlayRecoveryConfig,
  nowMs: number
): XsOverlayRecoveryState {
  const launchAttempts = state.launchAttempts + 1;
  const retryDelayMs = retryDelayFor(launchAttempts, config);
  const nextLaunchAtMs =
    launchAttempts < config.maxLaunchAttempts
      ? nowMs + config.launchGraceMs + retryDelayMs
      : undefined;

  return {
    ...state,
    launchAttempts,
    nextLaunchAtMs,
    exhausted: false
  };
}

function retryDelayFor(launchAttempts: number, config: XsOverlayRecoveryConfig): number {
  const delayIndex = launchAttempts - 1;
  return Math.max(0, config.retryDelaysMs[delayIndex] ?? 0);
}
