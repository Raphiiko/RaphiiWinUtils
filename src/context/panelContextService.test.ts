import assert from "node:assert/strict";
import test from "node:test";
import { Logger } from "../system/logger.ts";
import { EMPTY_CONTEXT, PanelContextService, photoshopDocument } from "./panelContextService.ts";
import { NO_FOREGROUND, type ForegroundState, type ForegroundWatcher } from "./foregroundWatcher.ts";
import type { PanelContextConfig } from "../config/schema.ts";

const config: PanelContextConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 17643,
  token: "secret",
  apps: { photoshop: "photoshop" },
  hotkeys: { "photoshop.undo": "ctrl+z" },
  actions: {
    "photoshop.mirrorOn": "Kipfel/Symmetry Last",
    "photoshop.mirrorOff": "Kipfel/Symmetry Off"
  }
};

class FakeBrush {
  played: string[] = [];
  refreshed = 0;
  read(): { brushSize: number; brushAngle: number } | null {
    return null;
  }
  refresh(): void {
    this.refreshed++;
  }
  setSize(): void {}
  setAngle(): void {}
  subscribe(): () => void {
    return () => {};
  }
  playAction(set: string, name: string): boolean {
    this.played.push(`${set}/${name}`);
    return true;
  }

}

class FakeWatcher {
  state: ForegroundState = NO_FOREGROUND;
  sent: string[] = [];
  private listener?: (state: ForegroundState) => void;

  current(): ForegroundState {
    return this.state;
  }

  subscribe(listener: (state: ForegroundState) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  sendHotkey(keys: string): boolean {
    this.sent.push(keys);
    return true;
  }

  emit(state: ForegroundState): void {
    this.state = state;
    this.listener?.(state);
  }
}

const serviceWith = (watcher: FakeWatcher, brush?: FakeBrush) =>
  new PanelContextService(config, watcher as unknown as ForegroundWatcher, new Logger("test"), brush);

void test("photoshopDocument keeps only the file name", () => {
  assert.equal(
    photoshopDocument("Adobe Photoshop 2026 - kipfel_overlay_v3.psd @ 66% (Layer 1, RGB/8) *"),
    "kipfel_overlay_v3.psd"
  );
  assert.equal(photoshopDocument("kipfel.psd @ 100%"), "kipfel.psd");
});

void test("photoshopDocument reports no document for a bare product window", () => {
  assert.equal(photoshopDocument("Adobe Photoshop 2026"), null);
  assert.equal(photoshopDocument(null), null);
  assert.equal(photoshopDocument(""), null);
});

void test("an unmapped process produces no context", () => {
  const watcher = new FakeWatcher();
  const service = serviceWith(watcher);
  service.start();
  watcher.emit({ process: "chrome", title: "kipfel.psd @ 66%", pid: 7 });
  assert.deepEqual(service.snapshot(), EMPTY_CONTEXT);
});

void test("a mapped process produces its app id and document", () => {
  const watcher = new FakeWatcher();
  const service = serviceWith(watcher);
  service.start();
  watcher.emit({ process: "photoshop", title: "Adobe Photoshop 2026 - a.psd @ 50%", pid: 9 });
  assert.deepEqual(service.snapshot(), { app: "photoshop", title: "a.psd", photoshop: null });
});

void test("a hotkey command reaches the watcher only while its app is focused", () => {
  const watcher = new FakeWatcher();
  const service = serviceWith(watcher);
  service.start();

  assert.equal(service.apply("photoshop", "undo"), false, "not focused yet");
  assert.deepEqual(watcher.sent, []);

  watcher.emit({ process: "photoshop", title: "Adobe Photoshop 2026 - a.psd @ 50%", pid: 9 });
  assert.equal(service.apply("photoshop", "undo"), true);
  assert.deepEqual(watcher.sent, ["ctrl+z"]);
});

void test("an unbound command sends nothing", () => {
  const watcher = new FakeWatcher();
  const service = serviceWith(watcher);
  service.start();
  watcher.emit({ process: "photoshop", title: "Adobe Photoshop 2026 - a.psd @ 50%", pid: 9 });
  assert.equal(service.apply("photoshop", "flipCanvas"), false);
  assert.deepEqual(watcher.sent, []);
});

void test("brush commands are dropped while no transport exists", () => {
  const watcher = new FakeWatcher();
  const service = serviceWith(watcher);
  service.start();
  watcher.emit({ process: "photoshop", title: "Adobe Photoshop 2026 - a.psd @ 50%", pid: 9 });
  assert.equal(service.apply("photoshop", "setBrushSize", 200), false);
  assert.equal(service.snapshot().photoshop, null);
});

void test("the two mirror keys each play their own Action", () => {
  const watcher = new FakeWatcher();
  const brush = new FakeBrush();
  const service = serviceWith(watcher, brush);
  service.start();
  watcher.emit({ process: "photoshop", title: "Adobe Photoshop 2026 - a.psd @ 50%", pid: 9 });

  assert.equal(service.apply("photoshop", "mirrorOn"), true);
  assert.equal(service.apply("photoshop", "mirrorOff"), true);
  // Each key is one Action, so pressing the same one twice is a no-op in
  // Photoshop rather than a flip — there is no state to get out of phase.
  assert.equal(service.apply("photoshop", "mirrorOff"), true);
  assert.deepEqual(brush.played, [
    "Kipfel/Symmetry Last",
    "Kipfel/Symmetry Off",
    "Kipfel/Symmetry Off"
  ]);
  assert.deepEqual(watcher.sent, [], "an action must not also send a keystroke");
});

void test("Photoshop taking focus asks for one brush read", () => {
  const watcher = new FakeWatcher();
  const brush = new FakeBrush();
  const service = serviceWith(watcher, brush);
  service.start();
  watcher.emit({ process: "photoshop", title: "Adobe Photoshop 2026 - a.psd @ 50%", pid: 9 });
  assert.equal(brush.refreshed, 1);
  // A title change while it keeps focus must not trigger another read.
  watcher.emit({ process: "photoshop", title: "Adobe Photoshop 2026 - a.psd @ 75%", pid: 9 });
  assert.equal(brush.refreshed, 1);
});

void test("losing focus clears the context", () => {
  const watcher = new FakeWatcher();
  const service = serviceWith(watcher);
  service.start();
  watcher.emit({ process: "photoshop", title: "Adobe Photoshop 2026 - a.psd @ 50%", pid: 9 });
  watcher.emit(NO_FOREGROUND);
  assert.deepEqual(service.snapshot(), EMPTY_CONTEXT);
});
