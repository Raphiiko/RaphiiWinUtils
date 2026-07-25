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
  type: "ready" | "endpoint" | "snapshot" | "error" | "volume-policy-result";
  endpoints?: AudioEndpointState[];
  endpoint?: AudioEndpointState;
  message?: string;
  error?: string;
  requestId?: string;
  results?: AudioEndpointVolumePolicyResult[];
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
