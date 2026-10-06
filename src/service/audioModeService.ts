import type {
  AppConfig,
  AudioMicConfig,
  AudioModeConfig,
  AudioModeMicRoute
} from "../config/schema.ts";
import {
  WindowsAudioEndpointVolumeController,
  type AudioEndpointVolumeController,
  type AudioEndpointVolumePolicy
} from "../audio/audioEndpointVolumeController.ts";
import { buildAudioModeVolumePolicies } from "../audio/audioModeVolumePolicies.ts";
import type { AudioModePublisher } from "../mqtt/audioModePublisher.ts";
import { VbanTextClient } from "../matrix/vbanTextClient.ts";
import { Logger } from "../system/logger.ts";

interface MatrixTextClient {
  send(command: string): Promise<void>;
  request(command: string, timeoutMs?: number): Promise<string[]>;
  close(): Promise<void>;
}

interface AudioModeServiceDependencies {
  createMatrixClient?: () => MatrixTextClient;
  delay?: (ms: number) => Promise<void>;
  volumeController?: AudioEndpointVolumeController;
  filterPreOutputVolumePolicies?: (
    policies: AudioEndpointVolumePolicy[]
  ) => AudioEndpointVolumePolicy[];
}

const preSwitchVolumePolicyWaitMs = 1_000;
const outputPollMs = 100;
const pendingModeTimeoutMs = 60_000;
const pendingModeRetryGapMs = 5_000;

export interface AudioModeSummary {
  id: string;
  name: string;
  outputDeviceName: string;
  mic: string;
}

export interface AudioMicSummary {
  id: string;
  name: string;
  inputSlot: string;
}

export class AudioModeService {
  private readonly log: Logger;
  private readonly config: AppConfig;
  private publisher: AudioModePublisher;
  private readonly createMatrixClient: () => MatrixTextClient;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly volumeController: AudioEndpointVolumeController;
  private readonly filterPreOutputVolumePolicies: (
    policies: AudioEndpointVolumePolicy[]
  ) => AudioEndpointVolumePolicy[];
  private applyModeTail: Promise<unknown> = Promise.resolve();
  private queuedApplies = 0;
  private pendingMode?: { id: string; until: number; nextRetryAt: number };

  constructor(
    config: AppConfig,
    logger: Logger,
    publisher: AudioModePublisher,
    dependencies: AudioModeServiceDependencies = {}
  ) {
    this.config = config;
    this.log = logger.child("audio-modes");
    this.publisher = publisher;
    this.createMatrixClient =
      dependencies.createMatrixClient ?? (() => new VbanTextClient(this.config.matrix, this.log));
    this.delay = dependencies.delay ?? delay;
    this.volumeController =
      dependencies.volumeController ?? new WindowsAudioEndpointVolumeController(this.log);
    this.filterPreOutputVolumePolicies =
      dependencies.filterPreOutputVolumePolicies ?? ((policies) => policies);
  }

  listModes(): AudioModeSummary[] {
    return Object.entries(this.config.audioModes.modes).map(([id, mode]) => ({
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      mic: mode.mic
    }));
  }

  listMics(): AudioMicSummary[] {
    return Object.entries(this.config.audioModes.mics).map(([id, mic]) => ({
      id,
      name: mic.name,
      inputSlot: mic.inputSlot
    }));
  }

  getMode(id: string): AudioModeConfig | undefined {
    return this.config.audioModes.modes[id];
  }

  setPublisher(publisher: AudioModePublisher): void {
    this.publisher = publisher;
  }

  /** Switches the output and the mode's preferred mic. */
  async applyMode(id: string): Promise<AudioModeSummary> {
    return this.enqueue(() => this.applyModeOnce(id));
  }

  /** Switches only the mic and leaves the output alone. */
  async applyMic(id: string): Promise<AudioMicSummary> {
    return this.enqueue(() => this.applyMicOnce(id));
  }

  private async enqueue<T>(apply: () => Promise<T>): Promise<T> {
    this.queuedApplies++;
    const operation = this.applyModeTail.then(apply).finally(() => {
      this.queuedApplies--;
    });
    this.applyModeTail = operation.catch(() => undefined);
    return operation;
  }

  isApplying(): boolean {
    return this.queuedApplies > 0;
  }

  /**
   * A mode whose output could not be selected stays pending for a minute, so pressing it
   * before the device has connected still takes effect once Windows shows the endpoint.
   */
  async retryPendingMode(renderEndpointNames: string[], now = Date.now()): Promise<void> {
    const pending = this.pendingMode;
    if (!pending || this.isApplying() || now < pending.nextRetryAt) return;

    if (now > pending.until) {
      this.pendingMode = undefined;
      this.log.info("Gave up waiting for the audio mode output to connect", { id: pending.id });
      return;
    }

    const mode = this.getMode(pending.id);
    if (
      !mode ||
      !isAudioDevicePresent(renderEndpointNames, mode.outputDeviceName, mode.outputDriver)
    ) {
      return;
    }

    this.log.info("Audio mode output connected; applying the pending mode", { id: pending.id });
    try {
      await this.applyMode(pending.id);
    } catch (error: unknown) {
      if (this.pendingMode?.id === pending.id) {
        this.pendingMode = { ...pending, nextRetryAt: now + pendingModeRetryGapMs };
      }
      this.log.warn("Pending audio mode still could not be applied", {
        id: pending.id,
        error: formatUnknownError(error)
      });
    }
  }

  private async applyModeOnce(id: string): Promise<AudioModeSummary> {
    const mode = this.getMode(id);
    if (!mode) {
      throw new UnknownAudioModeError(id);
    }
    const mic = this.config.audioModes.mics[mode.mic];
    if (!mic) {
      throw new Error(`Audio mode ${id} names an unknown mic: ${mode.mic}`);
    }

    const outputCommand = this.buildOutputCommand(mode);
    const summary = {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      mic: mode.mic
    };
    const volumePolicies = buildAudioModeVolumePolicies(this.config, mode);

    const beforeOutputVolumePromise = this.applyPreOutputVolumePolicies(
      id,
      this.filterPreOutputVolumePolicies(volumePolicies.beforeOutputSwitch)
    ).then(
      () => undefined,
      (error: unknown) => error
    );

    this.pendingMode = undefined;
    let outputVerification: { attempts: number; matrixRestarted: boolean };
    try {
      outputVerification = await this.applyOutputWithRetry(mode, outputCommand);
    } catch (error) {
      const now = Date.now();
      this.pendingMode = { id, until: now + pendingModeTimeoutMs, nextRetryAt: now };
      const volumeError = await beforeOutputVolumePromise;
      if (volumeError) {
        this.log.warn("Pre-output volume policy failed after output switch failure", {
          id,
          error: formatUnknownError(volumeError)
        });
      }
      throw error;
    }

    const volumeError = await beforeOutputVolumePromise;
    if (volumeError) throw toError(volumeError);

    await this.volumeController.apply(volumePolicies.afterOutputSwitch);

    const verification = await this.applyMicRoutingWithRetry(mic);

    this.log.info("Audio mode applied", {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      mic: mode.mic,
      outputAttempts: outputVerification.attempts,
      matrixRestarted: outputVerification.matrixRestarted,
      routeAttempts: verification.attempts
    });

    // State is published only after all local output, volume and mic-route checks succeeded.
    void this.publishAppliedMode(id, summary);

    return summary;
  }

  private async applyMicOnce(id: string): Promise<AudioMicSummary> {
    const mic = this.config.audioModes.mics[id];
    if (!mic) {
      throw new UnknownAudioMicError(id);
    }

    const verification = await this.applyMicRoutingWithRetry(mic);
    this.log.info("Audio mic applied", {
      id,
      name: mic.name,
      inputSlot: mic.inputSlot,
      routeAttempts: verification.attempts
    });

    const summary = { id, name: mic.name, inputSlot: mic.inputSlot };
    void this.publisher.publishMic(id).catch((error: unknown) => {
      this.log.warn("Could not publish applied audio mic to Home Assistant", {
        id,
        error: formatUnknownError(error)
      });
    });
    return summary;
  }

  stop(): void {
    // Mode commands use short-lived VBAN sockets.
  }

  private buildOutputCommand(mode: AudioModeConfig): string {
    const slot = this.config.audioModes.mainOutputSlot;
    return (
      `Slot(${slot}).Device.${outputDriver(mode)} = "${escapeMatrixString(mode.outputDeviceName)}";` +
      `Slot(${slot}).Online = 1;`
    );
  }

  private buildMicCommands(mic: AudioMicConfig): { resetCommand: string; routeCommand: string } {
    const mixSlot = this.config.audioModes.micMixOutputSlot;
    const routeCommands = [];
    for (const route of mic.routes) {
      const point = `Point(${mic.inputSlot}[${route.inputChannel}],${mixSlot}.OUT[${route.outputChannel}])`;
      routeCommands.push(`${point}.dBGain = 0.0`);
      routeCommands.push(`${point}.Mute = 0`);
    }

    return {
      resetCommand: `Output(${mixSlot}.OUT[${formatChannelRange(
        this.config.audioModes.micOutputChannels
      )}]).Reset;`,
      routeCommand: `${routeCommands.join(";")};`
    };
  }

  private async publishAppliedMode(id: string, summary: AudioModeSummary): Promise<void> {
    try {
      await this.publisher.publishMode(summary, this.listModes());
    } catch (error: unknown) {
      this.log.warn("Could not publish applied audio mode to Home Assistant", {
        id,
        error: formatUnknownError(error)
      });
    }
  }

  private async sendMatrixCommand(command: string): Promise<void> {
    const client = this.createMatrixClient();
    try {
      await client.send(command);
    } finally {
      await client.close();
    }
  }

  private async applyPreOutputVolumePolicies(
    modeId: string,
    policies: Parameters<AudioEndpointVolumeController["apply"]>[0]
  ): Promise<void> {
    let completed = false;
    const applyPromise = this.volumeController.apply(policies).finally(() => {
      completed = true;
    });

    await Promise.race([applyPromise, this.delay(preSwitchVolumePolicyWaitMs)]);
    if (!completed) {
      this.log.warn("Audio endpoint volume cap is slow; switching output while it continues", {
        modeId,
        waitMs: preSwitchVolumePolicyWaitMs
      });
    }

    await applyPromise;
  }

  private async applyOutputWithRetry(
    mode: AudioModeConfig,
    outputCommand: string
  ): Promise<{ attempts: number; matrixRestarted: boolean }> {
    const attempts = Math.max(1, this.config.audioModes.outputRetryCount);
    let actual: { driver?: string; name?: string } = {};
    let matrixRestarted = false;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.sendMatrixCommand(outputCommand);

      actual = await this.waitForOutputDevice(mode);
      if (isOutputSelected(actual, mode)) {
        return { attempts: attempt, matrixRestarted };
      }

      if (attempt >= attempts) break;

      this.log.warn("Matrix output switch did not take effect; restarting audio engine", {
        attempt,
        expectedDeviceName: mode.outputDeviceName,
        expectedDriver: outputDriver(mode),
        actualDeviceName: actual.name,
        actualDriver: actual.driver
      });
      await this.sendMatrixCommand("Command.Restart = 1;");
      matrixRestarted = true;
      await this.delay(this.config.audioModes.engineSettleMs);
    }

    throw new Error(
      `Could not switch ${this.config.audioModes.mainOutputSlot} to ${outputDriver(mode)} "${mode.outputDeviceName}"` +
        ` after ${attempts} attempt(s); Matrix reports ${
          actual.name === undefined
            ? "no response"
            : `${actual.driver ?? "no driver"} "${actual.name}"`
        }. RWU retries for ${pendingModeTimeoutMs / 1000} s whenever Windows shows the device.`
    );
  }

  /** Polls until Matrix reports the mode's output, for at most engineSettleMs. */
  private async waitForOutputDevice(
    mode: AudioModeConfig
  ): Promise<{ driver?: string; name?: string }> {
    const polls = Math.max(1, Math.ceil(this.config.audioModes.engineSettleMs / outputPollMs));
    let actual: { driver?: string; name?: string } = {};
    for (let poll = 0; poll < polls; poll++) {
      await this.delay(outputPollMs);
      actual = await this.queryOutputDevice();
      if (isOutputSelected(actual, mode)) break;
    }
    return actual;
  }

  private async queryOutputDevice(): Promise<{ driver?: string; name?: string }> {
    const command = `Slot(${this.config.audioModes.mainOutputSlot}).Device = ?;`;
    const client = this.createMatrixClient();
    try {
      const responses = await client.request(command, 500);
      const response = responses.find((candidate) => candidate.includes(".Device"));
      return {
        driver: response?.match(/\.Device\.(\w+)\s*=/)?.[1],
        name: parseStringResponse(response)
      };
    } finally {
      await client.close();
    }
  }

  private async applyMicRoutingWithRetry(mic: AudioMicConfig): Promise<{ attempts: number }> {
    const { resetCommand, routeCommand } = this.buildMicCommands(mic);
    const attempts = Math.max(1, this.config.audioModes.routeRetryCount);
    let lastFailure: MatrixRouteVerification | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await this.delay(this.config.audioModes.routeRetryDelayMs);
      // Matrix runs the commands of one packet in order, so the reset lands before the route.
      await this.sendMatrixCommand(`${resetCommand}${routeCommand}`);

      const verification = await this.verifyMicRouting(mic);
      if (verification.ok) {
        if (attempt > 1) {
          this.log.info("Mic route verified after retry", { attempt, mic: mic.name });
        }
        return { attempts: attempt };
      }

      lastFailure = verification;
      this.log.warn("Mic route verification failed; retrying", {
        attempt,
        mic: mic.name,
        failures: verification.failures
      });
    }

    throw new Error(
      `Could not verify mic route for ${mic.name}: ${JSON.stringify(lastFailure?.failures ?? [])}`
    );
  }

  private async verifyMicRouting(mic: AudioMicConfig): Promise<MatrixRouteVerification> {
    const expected = new Set(mic.routes.map((route) => routeKey(mic.inputSlot, route)));
    const failures: string[] = [];
    const candidates = this.getKnownMicRouteCandidates();
    const gains = await this.queryPointGains(candidates);

    for (const candidate of candidates) {
      const key = routeKey(candidate.inputSlot, candidate);
      const gain = gains.get(this.pointName(candidate));
      const shouldExist = expected.has(key);

      if (gain === undefined) {
        failures.push(`${key} did not reply`);
        continue;
      }

      if (shouldExist && Math.abs(gain) > 0.05) {
        failures.push(`${key} expected 0.0 dB, got ${formatGain(gain)}`);
      } else if (!shouldExist && gain !== Number.NEGATIVE_INFINITY) {
        failures.push(`${key} expected removed, got ${formatGain(gain)}`);
      }
    }

    return {
      ok: failures.length === 0,
      failures
    };
  }

  private getKnownMicRouteCandidates(): MicRouteCandidate[] {
    const inputPoints = new Map<string, { inputSlot: string; inputChannel: number }>();
    for (const mic of Object.values(this.config.audioModes.mics)) {
      for (const route of mic.routes) {
        const key = `${mic.inputSlot}[${route.inputChannel}]`;
        inputPoints.set(key, {
          inputSlot: mic.inputSlot,
          inputChannel: route.inputChannel
        });
      }
    }

    const candidates: MicRouteCandidate[] = [];
    for (const inputPoint of inputPoints.values()) {
      for (const outputChannel of this.config.audioModes.micOutputChannels) {
        candidates.push({ ...inputPoint, outputChannel });
      }
    }

    return candidates;
  }

  private pointName(candidate: MicRouteCandidate): string {
    return `Point(${candidate.inputSlot}[${candidate.inputChannel}],${this.config.audioModes.micMixOutputSlot}.OUT[${candidate.outputChannel}])`;
  }

  /** One packet asks for every point; Matrix answers them all in one reply. */
  private async queryPointGains(candidates: MicRouteCandidate[]): Promise<Map<string, number>> {
    const command = candidates
      .map((candidate) => `${this.pointName(candidate)}.dBGain = ?;`)
      .join(" ");
    const client = this.createMatrixClient();
    try {
      return parseGainResponses((await client.request(command, 500)).join(""));
    } finally {
      await client.close();
    }
  }
}

export class UnknownAudioModeError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`Unknown audio mode: ${id}`);
    this.id = id;
  }
}

export class UnknownAudioMicError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`Unknown audio mic: ${id}`);
    this.id = id;
  }
}

// The part in brackets is the driver device name, including the "2-" index that
// tells two identical adapters apart. The text before it is a user-editable label.
export function isSameAudioDevice(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  if (actual === expected) return true;

  const actualDevice = audioDeviceName(actual);
  return actualDevice !== undefined && actualDevice === audioDeviceName(expected);
}

function audioDeviceName(endpointName: string): string | undefined {
  return endpointName.match(/\(([^()]+)\)\s*$/)?.[1]?.trim().toLowerCase();
}

export function isAudioDevicePresent(
  endpointNames: string[],
  matrixDeviceName: string,
  driver = "WDM"
): boolean {
  return endpointNames.some((name) =>
    driver === "MME" ? name.startsWith(matrixDeviceName) : isSameAudioDevice(name, matrixDeviceName)
  );
}

function isOutputSelected(
  actual: { driver?: string; name?: string },
  mode: AudioModeConfig
): boolean {
  return (
    actual.driver === outputDriver(mode) && isSameAudioDevice(actual.name, mode.outputDeviceName)
  );
}

function outputDriver(mode: AudioModeConfig): string {
  return mode.outputDriver ?? "WDM";
}

export function escapeMatrixString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function formatChannelRange(channels: number[]): string {
  const sorted = [...channels].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted.at(-1);

  if (first === undefined || last === undefined) {
    throw new Error("At least one mic output channel is required");
  }

  const isContiguous = sorted.every((channel, index) => channel === first + index);
  return isContiguous && sorted.length > 1 ? `${first}..${last}` : sorted.join(",");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MicRouteCandidate extends AudioModeMicRoute {
  inputSlot: string;
}

interface MatrixRouteVerification {
  ok: boolean;
  failures: string[];
}

function routeKey(inputSlot: string, route: AudioModeMicRoute): string {
  return `${inputSlot}[${route.inputChannel}]->${route.outputChannel}`;
}

function parseGainResponses(reply: string): Map<string, number> {
  const gains = new Map<string, number>();
  for (const match of reply.matchAll(/(Point\([^)]*\))\.dBGain\s*=\s*([^;]+);/g)) {
    const value = match[2]?.trim();
    const gain = value === "-inf" ? Number.NEGATIVE_INFINITY : Number(value);
    if (match[1] && !Number.isNaN(gain)) gains.set(match[1], gain);
  }
  return gains;
}

function parseStringResponse(response: string | undefined): string | undefined {
  if (!response) return undefined;

  const match = response.match(/=\s*("(?:\\.|[^"])*");?\s*$/);
  if (!match?.[1]) return undefined;

  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

function formatGain(gain: number): string {
  return gain === Number.NEGATIVE_INFINITY ? "-inf" : gain.toFixed(1);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatUnknownError(error));
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
