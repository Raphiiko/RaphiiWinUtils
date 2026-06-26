import type { AppConfig, AudioModeConfig, AudioModeMicRoute } from "../config/schema.ts";
import {
  WindowsAudioEndpointVolumeController,
  type AudioEndpointVolumeController
} from "../audio/audioEndpointVolumeController.ts";
import { buildAudioModeVolumePolicies } from "../audio/audioModeVolumePolicies.ts";
import type { AudioModePublisher } from "../homeAssistant/audioModeWebhook.ts";
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
}

const preSwitchVolumePolicyWaitMs = 1_000;

export interface AudioModeSummary {
  id: string;
  name: string;
  outputDeviceName: string;
  micInputSlot: string;
  micRoutes: Array<{ inputChannel: number; outputChannel: number }>;
}

export class AudioModeService {
  private readonly log: Logger;
  private readonly config: AppConfig;
  private readonly publisher: AudioModePublisher;
  private readonly createMatrixClient: () => MatrixTextClient;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly volumeController: AudioEndpointVolumeController;
  private applyModeTail: Promise<unknown> = Promise.resolve();

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
  }

  listModes(): AudioModeSummary[] {
    return Object.entries(this.config.audioModes.modes).map(([id, mode]) => ({
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot,
      micRoutes: mode.micRoutes
    }));
  }

  getMode(id: string): AudioModeConfig | undefined {
    return this.config.audioModes.modes[id];
  }

  async applyMode(id: string): Promise<AudioModeSummary> {
    const operation = this.applyModeTail.then(() => this.applyModeOnce(id));
    this.applyModeTail = operation.catch(() => undefined);
    return operation;
  }

  private async applyModeOnce(id: string): Promise<AudioModeSummary> {
    const mode = this.getMode(id);
    if (!mode) {
      throw new UnknownAudioModeError(id);
    }

    const [outputCommand, resetCommand, routeCommand] = this.buildModeCommands(mode);
    if (!outputCommand || !resetCommand || !routeCommand) {
      throw new Error(
        `Invalid audio mode commands: ${JSON.stringify({
          outputCommand,
          resetCommand,
          routeCommand,
          mode
        })}`
      );
    }

    const summary = {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot,
      micRoutes: mode.micRoutes
    };
    const volumePolicies = buildAudioModeVolumePolicies(this.config, mode);

    void this.publishRequestedMode(id, summary);

    const beforeOutputVolumePromise = this.applyPreOutputVolumePolicies(
      id,
      volumePolicies.beforeOutputSwitch
    ).then(
      () => undefined,
      (error: unknown) => error
    );

    let outputVerification: { attempts: number; matrixRestarted: boolean };
    try {
      outputVerification = await this.applyOutputWithRetry(mode, outputCommand);
    } catch (error) {
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

    const verification = await this.applyMicRoutingWithRetry(mode, resetCommand, routeCommand);

    this.log.info("Audio mode applied", {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot,
      micRoutes: mode.micRoutes,
      outputAttempts: outputVerification.attempts,
      matrixRestarted: outputVerification.matrixRestarted,
      routeAttempts: verification.attempts
    });

    return summary;
  }

  stop(): void {
    // Mode commands use short-lived VBAN sockets.
  }

  private buildModeCommands(mode: AudioModeConfig): [string, string, string] {
    const outputCommands = [
      `Slot(${this.config.audioModes.mainOutputSlot}).Device.WDM = "${escapeMatrixString(
        mode.outputDeviceName
      )}"`,
      `Slot(${this.config.audioModes.mainOutputSlot}).Online = 1`
    ];

    const routeCommands = [];
    for (const route of mode.micRoutes) {
      const point = `Point(${mode.micInputSlot}[${route.inputChannel}],${this.config.audioModes.micMixOutputSlot}.OUT[${route.outputChannel}])`;
      routeCommands.push(`${point}.dBGain = 0.0`);
      routeCommands.push(`${point}.Mute = 0`);
    }

    return [
      `${outputCommands.join(";")};`,
      `Output(${this.config.audioModes.micMixOutputSlot}.OUT[${formatChannelRange(
        this.config.audioModes.micOutputChannels
      )}]).Reset;`,
      `${routeCommands.join(";")};`
    ];
  }

  private async publishRequestedMode(id: string, summary: AudioModeSummary): Promise<void> {
    try {
      await this.publisher.publishMode(summary, this.listModes());
    } catch (error: unknown) {
      this.log.warn("Could not publish requested audio mode to Home Assistant", {
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
    let actualDeviceName: string | undefined;
    let matrixRestarted = false;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.sendMatrixCommand(outputCommand);
      await this.delay(this.config.audioModes.engineSettleMs);

      actualDeviceName = await this.queryOutputDeviceName();
      if (actualDeviceName === mode.outputDeviceName) {
        return { attempts: attempt, matrixRestarted };
      }

      if (attempt >= attempts) break;

      this.log.warn("Matrix output switch did not take effect; restarting audio engine", {
        attempt,
        expectedDeviceName: mode.outputDeviceName,
        actualDeviceName
      });
      await this.sendMatrixCommand("Command.Restart = 1;");
      matrixRestarted = true;
      await this.delay(this.config.audioModes.engineSettleMs);
    }

    throw new Error(
      `Could not switch ${this.config.audioModes.mainOutputSlot} to "${mode.outputDeviceName}"` +
        ` after ${attempts} attempt(s); Matrix reports "${actualDeviceName ?? "no response"}"`
    );
  }

  private async queryOutputDeviceName(): Promise<string | undefined> {
    const command = `Slot(${this.config.audioModes.mainOutputSlot}).Device.WDM = ?;`;
    const client = this.createMatrixClient();
    try {
      const responses = await client.request(command, 500);
      return parseStringResponse(responses.find((response) => response.includes(".Device.WDM")));
    } finally {
      await client.close();
    }
  }

  private async applyMicRoutingWithRetry(
    mode: AudioModeConfig,
    resetCommand: string,
    routeCommand: string
  ): Promise<{ attempts: number }> {
    const attempts = Math.max(1, this.config.audioModes.routeRetryCount);
    let lastFailure: MatrixRouteVerification | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.sendMatrixCommand(resetCommand);
      await this.delay(100);
      await this.sendMatrixCommand(routeCommand);
      await this.delay(this.config.audioModes.routeRetryDelayMs);

      const verification = await this.verifyMicRouting(mode);
      if (verification.ok) {
        if (attempt > 1) {
          this.log.info("Mic route verified after retry", { attempt, mode: mode.name });
        }
        return { attempts: attempt };
      }

      lastFailure = verification;
      this.log.warn("Mic route verification failed; retrying", {
        attempt,
        mode: mode.name,
        failures: verification.failures
      });
    }

    throw new Error(
      `Could not verify mic route for ${mode.name}: ${JSON.stringify(lastFailure?.failures ?? [])}`
    );
  }

  private async verifyMicRouting(mode: AudioModeConfig): Promise<MatrixRouteVerification> {
    const expected = new Set(mode.micRoutes.map((route) => routeKey(mode.micInputSlot, route)));
    const failures: string[] = [];

    for (const candidate of this.getKnownMicRouteCandidates()) {
      const key = routeKey(candidate.inputSlot, candidate);
      const gain = await this.queryPointGain(
        candidate.inputSlot,
        candidate.inputChannel,
        candidate.outputChannel
      );
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
    for (const mode of Object.values(this.config.audioModes.modes)) {
      for (const route of mode.micRoutes) {
        const key = `${mode.micInputSlot}[${route.inputChannel}]`;
        inputPoints.set(key, {
          inputSlot: mode.micInputSlot,
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

  private async queryPointGain(
    inputSlot: string,
    inputChannel: number,
    outputChannel: number
  ): Promise<number | undefined> {
    const command = `Point(${inputSlot}[${inputChannel}],${this.config.audioModes.micMixOutputSlot}.OUT[${outputChannel}]).dBGain = ?;`;
    const client = this.createMatrixClient();
    try {
      const responses = await client.request(command, 500);
      return parseGainResponse(responses[0]);
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

function escapeMatrixString(value: string): string {
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

function parseGainResponse(response: string | undefined): number | undefined {
  if (!response) return undefined;

  const match = response.match(/=\s*([^;]+);?\s*$/);
  if (!match) return undefined;

  const value = match[1]?.trim();
  if (value === "-inf") return Number.NEGATIVE_INFINITY;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
