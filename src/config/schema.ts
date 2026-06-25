export interface AppConfig {
  matrix: MatrixConfig;
  audio: AudioConfig;
  audioModes: AudioModesConfig;
  homeAssistant: HomeAssistantConfig;
  clipboard: ClipboardAutomationConfig;
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
  endpointResyncMs: number;
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
  micOutputChannels: number[];
  defaultChannelVolumeCapPercent: number;
  engineSettleMs: number;
  outputRetryCount: number;
  routeRetryCount: number;
  routeRetryDelayMs: number;
  modes: Record<string, AudioModeConfig>;
}

export interface AudioModeConfig {
  name: string;
  outputDeviceName: string;
  micInputSlot: string;
  micRoutes: AudioModeMicRoute[];
  channelVolumeOverrides?: Record<string, number>;
}

export interface AudioModeMicRoute {
  inputChannel: number;
  outputChannel: number;
}

export interface HomeAssistantConfig {
  enabled: boolean;
  audioModeWebhookUrl: string;
  requestTimeoutMs: number;
}

export interface ClipboardAutomationConfig {
  enabled: boolean;
  debounceMs: number;
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
    endpointResyncMs: 60000,
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
    micMixOutputSlot: "VAIO1",
    micOutputChannels: [1, 2],
    defaultChannelVolumeCapPercent: 30,
    engineSettleMs: 2500,
    outputRetryCount: 2,
    routeRetryCount: 5,
    routeRetryDelayMs: 500,
    modes: {
      "desk-mic": {
        name: "Desk Mic",
        outputDeviceName: "Headset (3- Arctis Nova Pro Wireless)",
        micInputSlot: "WIN1.IN",
        micRoutes: [
          { inputChannel: 1, outputChannel: 1 },
          { inputChannel: 1, outputChannel: 2 }
        ]
      },
      beyond: {
        name: "Beyond",
        outputDeviceName: "Bigscreen Beyond (USB-C to 3.5mm Headphone Jack Adapter)",
        micInputSlot: "WIN3.IN",
        channelVolumeOverrides: {
          Game: 100
        },
        micRoutes: [
          { inputChannel: 1, outputChannel: 1 },
          { inputChannel: 2, outputChannel: 2 }
        ]
      },
      headset: {
        name: "Headset",
        outputDeviceName: "Headset (3- Arctis Nova Pro Wireless)",
        micInputSlot: "WIN2.IN",
        micRoutes: [
          { inputChannel: 1, outputChannel: 1 },
          { inputChannel: 2, outputChannel: 2 }
        ]
      },
      iem: {
        name: "IEM",
        outputDeviceName: "In Ear Monitors (2- USB-C to 3.5mm Headphone Jack Adapter)",
        micInputSlot: "WIN1.IN",
        micRoutes: [
          { inputChannel: 1, outputChannel: 1 },
          { inputChannel: 1, outputChannel: 2 }
        ]
      },
      speaker: {
        name: "Speaker",
        outputDeviceName: "Desktop Speakers (USB SPDIF Adapter)",
        micInputSlot: "WIN1.IN",
        micRoutes: [
          { inputChannel: 1, outputChannel: 1 },
          { inputChannel: 1, outputChannel: 2 }
        ]
      },
      tws: {
        name: "TWS",
        outputDeviceName: "Nothing Ear (Nothing Ear)",
        micInputSlot: "WIN1.IN",
        micRoutes: [
          { inputChannel: 1, outputChannel: 1 },
          { inputChannel: 1, outputChannel: 2 }
        ]
      }
    }
  },
  homeAssistant: {
    enabled: false,
    audioModeWebhookUrl: "",
    requestTimeoutMs: 3000
  },
  clipboard: {
    enabled: true,
    debounceMs: 100
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
