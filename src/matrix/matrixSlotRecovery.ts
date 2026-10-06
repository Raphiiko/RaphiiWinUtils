import type { MatrixConfig } from "../config/schema.ts";
import { escapeMatrixString, isAudioDevicePresent } from "../service/audioModeService.ts";
import { Logger } from "../system/logger.ts";
import { VbanTextClient } from "./vbanTextClient.ts";

export interface MatrixSlot {
  slot: string;
  driver?: string;
  device: string;
  running: boolean;
}

export interface StalledSlot {
  attempts: number;
  nextAttemptAt: number;
}

export type SlotRecoveryAction =
  | { kind: "reassign"; slot: MatrixSlot; attempt: number }
  | { kind: "restart"; slot: MatrixSlot }
  | { kind: "recovered"; slot: MatrixSlot };

interface AudioModes {
  isApplying(): boolean;
  retryPendingMode(renderEndpointNames: string[]): Promise<void>;
}

const slotNames = ["IN", "OUT"].flatMap((direction) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((index) => `WIN${index}.${direction}`)
);
const statusQuery = slotNames
  .map((slot) => `Slot(${slot}).Device = ?; Slot(${slot}).Running = ?;`)
  .join(" ");
const firstRetryMs = 2_000;
const maxRetryMs = 30_000;
const minRestartGapMs = 30_000;

/**
 * Matrix keeps a slot's device name after the device disappears, but never reopens it when it
 * returns. This re-assigns such slots, and restarts the engine for an output Windows shows again.
 */
export class MatrixSlotRecovery {
  private readonly log: Logger;
  private readonly client: VbanTextClient;
  private readonly pollMs: number;
  private readonly audioModes: AudioModes;
  private readonly renderEndpointNames: () => string[];
  private readonly stalled = new Map<string, StalledSlot>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private lastRestartAt = Number.NEGATIVE_INFINITY;

  constructor(
    matrix: MatrixConfig,
    pollMs: number,
    audioModes: AudioModes,
    renderEndpointNames: () => string[],
    logger: Logger
  ) {
    this.log = logger.child("matrix-recovery");
    this.client = new VbanTextClient(matrix, this.log);
    this.pollMs = pollMs;
    this.audioModes = audioModes;
    this.renderEndpointNames = renderEndpointNames;
  }

  start(): void {
    if (this.pollMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** A device that just came back skips the remaining backoff. */
  endpointsChanged(): void {
    for (const state of this.stalled.values()) state.nextAttemptAt = 0;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.audioModes.isApplying()) return;
    this.ticking = true;
    try {
      const endpointNames = this.renderEndpointNames();
      await this.audioModes.retryPendingMode(endpointNames);
      if (this.audioModes.isApplying()) return;

      const slots = parseMatrixSlots((await this.client.request(statusQuery, 500)).join(""));
      const now = Date.now();
      const actions = planSlotRecovery(slots, endpointNames, this.stalled, now, this.lastRestartAt);
      for (const action of actions) await this.run(action, now);
    } catch (error: unknown) {
      this.log.warn("Matrix slot check failed", { error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async run(action: SlotRecoveryAction, now: number): Promise<void> {
    const { slot } = action;
    const meta = { slot: slot.slot, driver: slot.driver, device: slot.device };
    if (action.kind === "recovered") {
      this.log.info("Matrix slot is running again", meta);
    } else if (action.kind === "restart") {
      this.log.warn("Matrix slot still not running; restarting audio engine", meta);
      this.lastRestartAt = now;
      await this.client.send("Command.Restart = 1;");
    } else if (slot.driver) {
      this.log.info("Matrix slot is not running; re-assigning its device", {
        ...meta,
        attempt: action.attempt
      });
      await this.client.send(
        `Slot(${slot.slot}).Device.${slot.driver} = "${escapeMatrixString(slot.device)}";` +
          `Slot(${slot.slot}).Online = 1;`
      );
    }
  }
}

export function parseMatrixSlots(reply: string): MatrixSlot[] {
  const slots = new Map<string, MatrixSlot>();
  const get = (slot: string) => {
    let entry = slots.get(slot);
    if (!entry) slots.set(slot, (entry = { slot, device: "", running: false }));
    return entry;
  };

  for (const match of reply.matchAll(
    /Slot\(([^)]+)\)\.Device(?:\.(\w+))?\s*=\s*("(?:\\.|[^"])*")/g
  )) {
    const entry = get(match[1] ?? "");
    entry.driver = match[2];
    entry.device = JSON.parse(match[3] ?? '""') as string;
  }
  for (const match of reply.matchAll(/Slot\(([^)]+)\)\.Running\s*=\s*(\d)/g)) {
    get(match[1] ?? "").running = match[2] === "1";
  }

  return [...slots.values()];
}

/**
 * Plans one check. A slot gets one tick of grace, because slots stop briefly while the engine
 * restarts. An output whose device Windows does not show is left alone. An output that Windows
 * shows gets one engine restart per stall, because a restart interrupts every slot.
 */
export function planSlotRecovery(
  slots: MatrixSlot[],
  renderEndpointNames: string[],
  stalled: Map<string, StalledSlot>,
  now: number,
  lastRestartAt: number
): SlotRecoveryAction[] {
  const actions: SlotRecoveryAction[] = [];
  let restart: SlotRecoveryAction | undefined;

  for (const slot of slots) {
    const state = stalled.get(slot.slot);
    if (!slot.device || slot.running) {
      stalled.delete(slot.slot);
      if (state && state.attempts > 0 && slot.running) actions.push({ kind: "recovered", slot });
      continue;
    }

    const present = slot.slot.endsWith(".OUT")
      ? isAudioDevicePresent(renderEndpointNames, slot.device, slot.driver)
      : undefined;
    if (present === false) {
      stalled.delete(slot.slot);
      continue;
    }

    if (!state) {
      stalled.set(slot.slot, { attempts: 0, nextAttemptAt: now + firstRetryMs });
      continue;
    }
    if (now < state.nextAttemptAt) continue;

    state.attempts++;
    state.nextAttemptAt = now + Math.min(firstRetryMs * 2 ** (state.attempts - 1), maxRetryMs);
    if (present && state.attempts === 2 && now - lastRestartAt >= minRestartGapMs) {
      restart ??= { kind: "restart", slot };
    } else {
      actions.push({ kind: "reassign", slot, attempt: state.attempts });
    }
  }

  if (!restart) return actions;
  return [...actions.filter((action) => action.kind === "recovered"), restart];
}
