import assert from "node:assert/strict";
import test from "node:test";
import type { HomeAssistantConfig } from "../config/schema.ts";
import type { AudioModeSummary } from "../service/audioModeService.ts";
import { HomeAssistantAudioModeWebhook } from "./audioModeWebhook.ts";

const mode: AudioModeSummary = {
  id: "speaker",
  name: "Speaker",
  outputDeviceName: "Desktop Speakers",
  micInputSlot: "WIN1.IN",
  micRoutes: [
    { inputChannel: 1, outputChannel: 1 },
    { inputChannel: 1, outputChannel: 2 }
  ]
};

void test("posts the applied mode and available mode IDs to Home Assistant", async () => {
  let request: { input: string | URL | Request; init?: RequestInit } | undefined;
  const fetchImpl: typeof fetch = (input, init) => {
    request = { input, init };
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const webhook = new HomeAssistantAudioModeWebhook(config(), fetchImpl);

  await webhook.publishMode(mode, [mode, { ...mode, id: "headset", name: "Headset" }]);

  assert.equal(request?.input, "http://homeassistant.local:8123/api/webhook/test");
  assert.equal(request?.init?.method, "POST");
  const requestBody = request?.init?.body;
  assert.equal(typeof requestBody, "string");
  if (typeof requestBody !== "string") throw new Error("Expected a JSON request body");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assert.deepEqual(
    {
      mode_id: body.mode_id,
      mode_name: body.mode_name,
      output_device_name: body.output_device_name,
      available_mode_ids: body.available_mode_ids
    },
    {
      mode_id: "speaker",
      mode_name: "Speaker",
      output_device_name: "Desktop Speakers",
      available_mode_ids: ["speaker", "headset"]
    }
  );
  assert.match(String(body.applied_at), /^\d{4}-\d{2}-\d{2}T/);
});

void test("does nothing when Home Assistant publishing is disabled", async () => {
  let called = false;
  const fetchImpl: typeof fetch = () => {
    called = true;
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const webhook = new HomeAssistantAudioModeWebhook(config({ enabled: false }), fetchImpl);

  await webhook.publishMode(mode, [mode]);

  assert.equal(called, false);
});

void test("rejects unsuccessful webhook responses", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(new Response("unknown webhook", { status: 404 }));
  const webhook = new HomeAssistantAudioModeWebhook(config(), fetchImpl);

  await assert.rejects(
    webhook.publishMode(mode, [mode]),
    /Home Assistant webhook returned 404: unknown webhook/
  );
});

function config(override: Partial<HomeAssistantConfig> = {}): HomeAssistantConfig {
  return {
    enabled: true,
    audioModeWebhookUrl: "http://homeassistant.local:8123/api/webhook/test",
    requestTimeoutMs: 3000,
    ...override
  };
}
