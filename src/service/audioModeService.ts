import type { AppConfig, AudioModeConfig, AudioModeMicRoute } from "../config/schema";
import { VbanTextClient } from "../matrix/vbanTextClient";
import { Logger } from "../system/logger";

export interface AudioModeSummary {
  id: string;
  name: string;
  outputDeviceName: string;
  micInputSlot: string;
  micRoutes: Array<{ inputChannel: number; outputChannel: number }>;
}

export class AudioModeService {
  private readonly log: Logger;

  constructor(
    private readonly config: AppConfig,
    logger: Logger
  ) {
    this.log = logger.child("audio-modes");
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

    await this.sendMatrixCommand(outputCommand);
    await delay(this.config.audioModes.engineSettleMs);

    const verification = await this.applyMicRoutingWithRetry(mode, resetCommand, routeCommand);

    this.log.info("Audio mode applied", {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot,
      micRoutes: mode.micRoutes,
      routeAttempts: verification.attempts
    });

    return {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot,
      micRoutes: mode.micRoutes
    };
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

  private async sendMatrixCommand(command: string): Promise<void> {
    const client = new VbanTextClient(this.config.matrix, this.log);
    try {
      await client.send(command);
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
      await delay(100);
      await this.sendMatrixCommand(routeCommand);
      await delay(this.config.audioModes.routeRetryDelayMs);

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
    const client = new VbanTextClient(this.config.matrix, this.log);
    try {
      const responses = await client.request(command, 500);
      return parseGainResponse(responses[0]);
    } finally {
      await client.close();
    }
  }
}

export class UnknownAudioModeError extends Error {
  constructor(readonly id: string) {
    super(`Unknown audio mode: ${id}`);
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

function formatGain(gain: number): string {
  return gain === Number.NEGATIVE_INFINITY ? "-inf" : gain.toFixed(1);
}
