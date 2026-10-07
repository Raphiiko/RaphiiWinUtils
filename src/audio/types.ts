export interface AudioEndpointState {
  id: string;
  name: string;
  dataFlow: string;
  volumeScalar: number;
  volumePercent: number;
  muted: boolean;
  source: "snapshot" | "event" | "resync" | "device-event";
}

export interface AudioWatcherMessage {
  type:
    | "ready"
    | "endpoint"
    | "snapshot"
    | "error"
    | "volume-policy-result"
    | "app-result"
    | "default-device-reset";
  endpoints?: AudioEndpointState[];
  endpoint?: AudioEndpointState;
  message?: string;
  error?: string;
  requestId?: string;
  results?: AudioEndpointVolumePolicyResult[];
  apps?: AppAudioSession[];
  icon?: string | null;
  flow?: string;
  role?: string;
  from?: string;
  to?: string;
}

export interface AudioEndpointVolumePolicyResult {
  endpointNameContains: string;
  endpointName?: string;
  targetVolumePercent: number;
  mode: "cap" | "set";
  found: boolean;
  changed: boolean;
  previousVolumePercent?: number;
  muted?: boolean;
}

export interface ChannelState {
  channelName: string;
  presetPatch: number;
  endpoint: AudioEndpointState;
  gainDb: number;
  muted: boolean;
}

export interface AppAudioSession {
  path: string;
  name: string;
  startedAt?: string;
  /** Endpoint the app is pinned to in Windows; absent when it follows the default device. */
  pinnedEndpointId?: string;
  /** Endpoints where the app has an active (open, not necessarily audible) session. */
  activeEndpointIds: string[];
  peak: number;
}
