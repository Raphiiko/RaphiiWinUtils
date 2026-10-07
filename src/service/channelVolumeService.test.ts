import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../config/schema.ts";
import type { AppAudioSession, ChannelState } from "../audio/types.ts";
import { Logger } from "../system/logger.ts";
import { ChannelVolumeService } from "./channelVolumeService.ts";

void test("maps app pins to channels and treats unpinned apps as the default channel", async () => {
  const { service } = serviceWith([
    session("game.exe", { pinnedEndpointId: "game-id" }),
    session("new.exe", { activeEndpointIds: ["system-id"] }),
    session("discord.exe", { activeEndpointIds: ["voice-id"] }),
    session("fixed.exe", { pinnedEndpointId: "headset-id" })
  ]);

  const apps = await service.listApps();
  const byPath = new Map(apps.map((app) => [app.path, app]));
  assert.equal(service.defaultChannelName(), "System");
  assert.equal(byPath.get("game.exe")?.channel, "Game");
  assert.equal(byPath.get("new.exe")?.channel, "System");
  assert.deepEqual(byPath.get("discord.exe")?.playsOn, ["Voice"]);
  assert.equal(byPath.get("fixed.exe")?.channel, null);
  assert.equal(byPath.get("fixed.exe")?.pinnedDevice, "Headset");
});

void test("moving an app to the default channel clears its pin", async () => {
  const { service, calls } = serviceWith([]);

  await service.setAppChannel("game.exe", "game");
  await service.setAppChannel("game.exe", "System");

  assert.deepEqual(calls, [
    ["game.exe", "game-id"],
    ["game.exe", undefined]
  ]);
});

function serviceWith(sessions: AppAudioSession[]) {
  const calls: Array<[string, string | undefined]> = [];
  const service = new ChannelVolumeService(structuredClone(defaultConfig), new Logger("test"));
  const internals = service as unknown as {
    watcher: unknown;
    endpointNamesById: Map<string, string>;
    latestStates: Map<string, ChannelState>;
  };
  internals.watcher = {
    listApps: () => Promise.resolve(sessions),
    setAppEndpoint: (path: string, endpointId?: string) => {
      calls.push([path, endpointId]);
      return Promise.resolve();
    }
  };
  internals.endpointNamesById = new Map([["headset-id", "Headset"]]);
  for (const [index, channel] of defaultConfig.audio.channels.entries()) {
    internals.latestStates.set(channel.name, {
      channelName: channel.name,
      presetPatch: index + 1,
      endpoint: { id: `${channel.name.toLowerCase()}-id` } as ChannelState["endpoint"],
      gainDb: 0,
      muted: false
    });
  }
  return { service, calls };
}

function session(path: string, overrides: Partial<AppAudioSession> = {}): AppAudioSession {
  return { path, name: path, activeEndpointIds: [], peak: 0, ...overrides };
}
