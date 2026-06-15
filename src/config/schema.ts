export interface AppConfig {
  matrix: MatrixConfig;
  audio: AudioConfig;
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
