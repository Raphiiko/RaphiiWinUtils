export interface AppConfig {
  matrix: MatrixConfig;
  audio: AudioConfig;
  audioModes: AudioModesConfig;
  updater: UpdaterConfig;
  control: ControlConfig;
  notifications: NotificationConfig;
}

export interface MatrixConfig {
  host: string;
  port: number;
  streamName: string;
  resyncEveryMs: number;
}

export interface AudioConfig {
  pollMs: number;
  minDb: number;
  maxDb: number;
  zeroVolumeMutes: boolean;
  channels: AudioChannelConfig[];
}

export interface AudioChannelConfig {
  name: string;
  endpointNameContains: string;
  presetPatch: number;
}

export interface AudioModesConfig {
  mainOutputSlot: string;
  micMixOutputSlot: string;
  micSourceChannelsToClear: number[];
  micOutputChannels: number[];
  micInputSlotsToClear: string[];
  modes: Record<string, AudioModeConfig>;
}

export interface AudioModeConfig {
  name: string;
  outputDeviceName: string;
  micInputSlot: string;
  micInputChannel: number;
}

export interface UpdaterConfig {
  enabled: boolean;
  repoUrl: string;
  branch: string;
  installDir: string;
  checkEveryMinutes: number;
}

export interface ControlConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface NotificationConfig {
  enabled: boolean;
  appName: string;
}

export const defaultConfig: AppConfig = {
  matrix: {
    host: "127.0.0.1",
    port: 6980,
    streamName: "Command1",
    resyncEveryMs: 5000
  },
  audio: {
    pollMs: 1000,
    minDb: -60,
    maxDb: 0,
    zeroVolumeMutes: true,
    channels: [
      { name: "System", endpointNameContains: "System Audio", presetPatch: 1 },
      { name: "Browser", endpointNameContains: "Browser Audio", presetPatch: 2 },
      { name: "Voice", endpointNameContains: "Voice Audio", presetPatch: 3 },
      { name: "Music", endpointNameContains: "Music Audio", presetPatch: 4 },
      { name: "Game", endpointNameContains: "Game Audio", presetPatch: 5 }
    ]
  },
  audioModes: {
    mainOutputSlot: "WIN1.OUT",
    micMixOutputSlot: "VAIO1.OUT",
    micSourceChannelsToClear: [1, 2],
    micOutputChannels: [1, 2],
    micInputSlotsToClear: ["WIN1.IN", "WIN2.IN", "WIN3.IN", "WIN4.IN", "WIN5.IN"],
    modes: {
      "desk-mic": {
        name: "Desk Mic",
        outputDeviceName: "Headset (3- Arctis Nova Pro Wireless)",
        micInputSlot: "WIN1.IN",
        micInputChannel: 1
      },
      beyond: {
        name: "Beyond",
        outputDeviceName: "Bigscreen Beyond (USB-C to 3.5mm Headphone Jack Adapter)",
        micInputSlot: "WIN3.IN",
        micInputChannel: 1
      },
      headset: {
        name: "Headset",
        outputDeviceName: "Headset (3- Arctis Nova Pro Wireless)",
        micInputSlot: "WIN2.IN",
        micInputChannel: 1
      },
      iem: {
        name: "IEM",
        outputDeviceName: "Headphones (2- USB-C to 3.5mm Headphone Jack Adapter)",
        micInputSlot: "WIN1.IN",
        micInputChannel: 1
      },
      speaker: {
        name: "Speaker",
        outputDeviceName: "Desktop Speakers (USB SPDIF Adapter)",
        micInputSlot: "WIN1.IN",
        micInputChannel: 1
      },
      tws: {
        name: "TWS",
        outputDeviceName: "Headphones (Nothing Ear)",
        micInputSlot: "WIN1.IN",
        micInputChannel: 1
      }
    }
  },
  updater: {
    enabled: true,
    repoUrl: "https://github.com/Raphiiko/RaphiiWinUtils.git",
    branch: "main",
    installDir: "C:\\Tools\\RaphiiWinUtils",
    checkEveryMinutes: 30
  },
  control: {
    enabled: true,
    host: "127.0.0.1",
    port: 17642
  },
  notifications: {
    enabled: true,
    appName: "RaphiiWinUtils"
  }
};
