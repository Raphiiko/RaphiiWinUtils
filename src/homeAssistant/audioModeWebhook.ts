import type { HomeAssistantConfig } from "../config/schema.ts";
import type { AudioModeSummary } from "../service/audioModeService.ts";

export interface AudioModePublisher {
  publishMode(mode: AudioModeSummary, availableModes: AudioModeSummary[]): Promise<void>;
}

export class HomeAssistantAudioModeWebhook implements AudioModePublisher {
  private readonly config: HomeAssistantConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HomeAssistantConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async publishMode(mode: AudioModeSummary, availableModes: AudioModeSummary[]): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.audioModeWebhookUrl.trim()) {
      throw new Error("Home Assistant audio mode webhook URL is not configured");
    }

    const response = await this.fetchImpl(this.config.audioModeWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        mode_id: mode.id,
        mode_name: mode.name,
        output_device_name: mode.outputDeviceName,
        available_mode_ids: availableModes.map((candidate) => candidate.id),
        applied_at: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    });

    if (!response.ok) {
      const responseBody = (await response.text()).trim();
      throw new Error(
        `Home Assistant webhook returned ${response.status}${
          responseBody ? `: ${responseBody.slice(0, 500)}` : ""
        }`
      );
    }
  }
}
