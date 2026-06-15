import type { AppConfig, AudioModeConfig } from "../config/schema";
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
    await delay(750);
    await this.sendMatrixCommand(resetCommand);
    await delay(50);
    await this.sendMatrixCommand(routeCommand);

    this.log.info("Audio mode applied", {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot,
      micRoutes: mode.micRoutes
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
