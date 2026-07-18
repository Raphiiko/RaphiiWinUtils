export interface AppConfig {
  matrix: MatrixConfig;
  audio: AudioConfig;
  audioModes: AudioModesConfig;
  mqtt: MqttConfig;
  clipboard: ClipboardAutomationConfig;
  xsOverlayRecovery: XsOverlayRecoveryConfig;
  vrChatRecovery: VrChatRecoveryConfig;
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

export interface MqttConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  /** Broker password. Keep this only in the local runtime config. */
  password: string;
  clientId: string;
  /** Root for command and confirmed-state topics for this PC. */
  baseTopic: string;
  discoveryPrefix: string;
  reconnectDelayMs: number;
}

export interface ClipboardAutomationConfig {
  enabled: boolean;
  debounceMs: number;
}

export interface XsOverlayRecoveryConfig {
  enabled: boolean;
  pollMs: number;
  missingConfirmationMs: number;
  launchGraceMs: number;
  retryDelaysMs: number[];
  maxLaunchAttempts: number;
  healthyResetMs: number;
  steamPath: string;
  steamAppId: string;
}

export interface VrChatRecoveryConfig {
  enabled: boolean;
  steamPath: string;
  steamVrAppId: string;
  vrChatAppId: string;
  vrChatExitWaitMs: number;
  steamVrExitWaitMs: number;
  steamVrStartWaitMs: number;
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
      "headset-desk-mic": {
        name: "Headset + Desk Mic",
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
      iems: {
        name: "IEMs",
        outputDeviceName: "In Ear Monitors (2- USB-C to 3.5mm Headphone Jack Adapter)",
        micInputSlot: "WIN1.IN",
        micRoutes: [
          { inputChannel: 1, outputChannel: 1 },
          { inputChannel: 1, outputChannel: 2 }
        ]
      },
      "desk-speakers": {
        name: "Desk Speakers",
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
  mqtt: {
    enabled: false,
    host: "homeassistant.local",
    port: 1883,
    username: "shirakami",
    password: "",
    clientId: "raphii-win-utils-shirakami",
    baseTopic: "raphiiwinutils/shirakami",
    discoveryPrefix: "homeassistant",
    reconnectDelayMs: 5000
  },
  clipboard: {
    enabled: true,
    debounceMs: 100
  },
  xsOverlayRecovery: {
    enabled: true,
    pollMs: 2000,
    missingConfirmationMs: 3000,
    launchGraceMs: 20000,
    retryDelaysMs: [3000, 15000, 60000, 300000],
    maxLaunchAttempts: 5,
    healthyResetMs: 60000,
    steamPath: "C:\\Program Files (x86)\\Steam\\steam.exe",
    steamAppId: "1173510"
  },
  vrChatRecovery: {
    enabled: true,
    steamPath: "C:\\Program Files (x86)\\Steam\\steam.exe",
    steamVrAppId: "250820",
    vrChatAppId: "438100",
    vrChatExitWaitMs: 3000,
    steamVrExitWaitMs: 5000,
    steamVrStartWaitMs: 5000
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
