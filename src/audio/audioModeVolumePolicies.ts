import type { AppConfig, AudioModeConfig } from "../config/schema.ts";
import type { AudioEndpointVolumePolicy } from "./audioEndpointVolumeController.ts";

export interface AudioModeVolumePolicies {
  beforeOutputSwitch: AudioEndpointVolumePolicy[];
  afterOutputSwitch: AudioEndpointVolumePolicy[];
}

export function buildAudioModeVolumePolicies(
  config: AppConfig,
  mode: AudioModeConfig
): AudioModeVolumePolicies {
  const defaultCap = validatePercent(
    config.audioModes.defaultChannelVolumeCapPercent,
    "audioModes.defaultChannelVolumeCapPercent"
  );
  const channelsByName = new Map(
    config.audio.channels.map((channel) => [channel.name.toLowerCase(), channel])
  );

  const beforeOutputSwitch = config.audio.channels.map((channel) => ({
    endpointNameContains: channel.endpointNameContains,
    volumePercent: defaultCap,
    mode: "cap" as const
  }));
  const afterOutputSwitch = Object.entries(mode.channelVolumeOverrides ?? {}).map(
    ([channelName, volumePercent]) => {
      const channel = channelsByName.get(channelName.toLowerCase());
      if (!channel) {
        throw new Error(`Unknown audio channel in mode volume override: ${channelName}`);
      }

      return {
        endpointNameContains: channel.endpointNameContains,
        volumePercent: validatePercent(
          volumePercent,
          `audio mode channelVolumeOverrides.${channelName}`
        ),
        mode: "set" as const
      };
    }
  );

  return { beforeOutputSwitch, afterOutputSwitch };
}

function validatePercent(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${path} must be between 0 and 100`);
  }
  return value;
}
