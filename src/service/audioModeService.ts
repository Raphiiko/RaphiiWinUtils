import type { AppConfig, AudioModeConfig } from "../config/schema";
import { VbanTextClient } from "../matrix/vbanTextClient";
import { Logger } from "../system/logger";

export interface AudioModeSummary {
  id: string;
  name: string;
  outputDeviceName: string;
  micInputSlot: string;
  micInputChannel: number;
}

export class AudioModeService {
  private readonly matrixClient: VbanTextClient;
  private readonly log: Logger;

  constructor(
    private readonly config: AppConfig,
    logger: Logger
  ) {
    this.log = logger.child("audio-modes");
    this.matrixClient = new VbanTextClient(config.matrix, this.log);
  }

  listModes(): AudioModeSummary[] {
    return Object.entries(this.config.audioModes.modes).map(([id, mode]) => ({
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot,
      micInputChannel: mode.micInputChannel
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

    const command = this.buildModeCommand(mode);
    await this.matrixClient.send(command);

    this.log.info("Audio mode applied", {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot
    });

    return {
      id,
      name: mode.name,
      outputDeviceName: mode.outputDeviceName,
      micInputSlot: mode.micInputSlot,
      micInputChannel: mode.micInputChannel
    };
  }

  stop(): void {
    void this.matrixClient.close();
  }

  private buildModeCommand(mode: AudioModeConfig): string {
    const commands = [
      `Slot(${this.config.audioModes.mainOutputSlot}).Device.WDM = "${escapeMatrixString(
        mode.outputDeviceName
      )}"`,
      `Slot(${this.config.audioModes.mainOutputSlot}).Online = 1`
    ];

    for (const inputSlot of this.config.audioModes.micInputSlotsToClear) {
      for (const inputChannel of this.config.audioModes.micSourceChannelsToClear) {
        for (const outputChannel of this.config.audioModes.micOutputChannels) {
          commands.push(
            `Point(${inputSlot}[${inputChannel}], ${this.config.audioModes.micMixOutputSlot}[${outputChannel}]).Remove`
          );
        }
      }
    }

    for (const outputChannel of this.config.audioModes.micOutputChannels) {
      const point = `Point(${mode.micInputSlot}[${mode.micInputChannel}], ${this.config.audioModes.micMixOutputSlot}[${outputChannel}])`;
      commands.push(`${point}.dBGain = 0.0`);
      commands.push(`${point}.Mute = 0`);
    }

    return `${commands.join(";")};`;
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
