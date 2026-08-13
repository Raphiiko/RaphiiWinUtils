import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { DictationMuteConfig } from "../config/schema.ts";
import type { DictationEvent } from "../dictation/handyLogWatcher.ts";
import { Logger } from "../system/logger.ts";
import { DictationMuteService } from "./dictationMuteService.ts";

const unmuteDelayMs = 40;

function config(): DictationMuteConfig {
  return {
    enabled: true,
    handyLogPath: "unused.log",
    pollMs: 1000,
    unmuteDelayMs,
    maxMuteMs: 10_000,
    discord: { clientId: "id", clientSecret: "secret" }
  };
}

function stubs(inVoiceChannel = true) {
  const calls: boolean[] = [];
  let muted = false;
  const discord = {
    isReady: true,
    connect: () => Promise.resolve(),
    close: () => {},
    isInVoiceChannel: () => Promise.resolve(inVoiceChannel),
    getMute: () => Promise.resolve(muted),
    setMute: (value: boolean) => {
      muted = value;
      calls.push(value);
      return Promise.resolve();
    }
  };

  let fire: (event: DictationEvent) => void = () => {};
  const watcher = {
    start: (onEvent: (event: DictationEvent) => void) => {
      fire = onEvent;
    },
    stop: () => {}
  };

  const service = new DictationMuteService(config(), new Logger("test", "error"), {
    discord,
    watcher
  });
  service.start();
  return { service, calls, fire: (event: DictationEvent) => fire(event) };
}

void test("mutes for a dictation and unmutes after the chime delay", async () => {
  const { service, calls, fire } = stubs();

  fire("start");
  await sleep(10);
  assert.deepEqual(calls, [true]);
  assert.equal(service.getStatus().muted, true);

  fire("stop");
  await sleep(10);
  assert.deepEqual(calls, [true], "the unmute waits for the delay");

  await sleep(unmuteDelayMs + 20);
  assert.deepEqual(calls, [true, false]);
  assert.equal(service.getStatus().muted, false);
  await service.stop();
});

void test("keeps the mute when the next dictation starts inside the delay", async () => {
  const { service, calls, fire } = stubs();

  fire("start");
  await sleep(10);
  fire("stop");
  fire("start");
  await sleep(unmuteDelayMs + 30);
  assert.deepEqual(calls, [true], "no unmute and no second mute");

  fire("stop");
  await sleep(unmuteDelayMs + 30);
  assert.deepEqual(calls, [true, false]);
  await service.stop();
});

void test("leaves the microphone alone outside a voice channel", async () => {
  const { service, calls, fire } = stubs(false);

  fire("start");
  await sleep(10);
  fire("stop");
  await sleep(unmuteDelayMs + 20);
  assert.deepEqual(calls, []);
  await service.stop();
});

void test("unmutes when the service stops mid-dictation", async () => {
  const { service, calls, fire } = stubs();

  fire("start");
  await sleep(10);
  await service.stop();
  assert.deepEqual(calls, [true, false]);
});
