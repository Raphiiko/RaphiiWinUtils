export interface AudioEndpointState {
  id: string;
  name: string;
  dataFlow: "Render" | "Capture" | string;
  volumeScalar: number;
  volumePercent: number;
  muted: boolean;
  source: "snapshot" | "event" | "poll";
}

export interface AudioWatcherMessage {
  type: "ready" | "endpoint" | "snapshot" | "error";
  endpoints?: AudioEndpointState[];
  endpoint?: AudioEndpointState;
  message?: string;
}

export interface ChannelState {
  channelName: string;
  presetPatch: number;
  endpoint: AudioEndpointState;
  gainDb: number;
  muted: boolean;
}
