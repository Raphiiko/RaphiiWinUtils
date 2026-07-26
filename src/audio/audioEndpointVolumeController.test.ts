import assert from "node:assert/strict";
import test from "node:test";
import { WatchedAudioEndpointVolumeController } from "./audioEndpointVolumeController.ts";

void test("coalesces queued endpoint volume writes to the latest value", async () => {
  const watcher = new DeferredVolumeWatcher();
  const controller = new WatchedAudioEndpointVolumeController(watcher);

  const first = controller.apply([policy(10)]);
  const second = controller.apply([policy(20)]);
  const third = controller.apply([policy(30)]);
  assert.deepEqual(watcher.values, [10]);

  watcher.resolveNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(watcher.values, [10, 30]);
  assert.deepEqual(watcher.endpointIds, ["endpoint-id", "endpoint-id"]);

  watcher.resolveNext();
  await Promise.all([first, second, third]);
});

function policy(volumePercent: number) {
  return {
    endpointNameContains: "Game Audio",
    endpointId: "endpoint-id",
    volumePercent,
    mode: "set" as const
  };
}

class DeferredVolumeWatcher {
  readonly values: number[] = [];
  readonly endpointIds: Array<string | undefined> = [];
  private readonly resolvers: Array<() => void> = [];

  async setVolume(endpointNameContains: string, volumePercent: number, endpointId?: string) {
    this.values.push(volumePercent);
    this.endpointIds.push(endpointId);
    await new Promise<void>((resolve) => this.resolvers.push(resolve));
    return [
      {
        endpointNameContains,
        targetVolumePercent: volumePercent,
        mode: "set" as const,
        found: true,
        changed: true
      }
    ];
  }

  resolveNext(): void {
    this.resolvers.shift()?.();
  }
}
