import assert from "node:assert/strict";
import test from "node:test";
import { Logger } from "../system/logger.ts";
import { PhotoshopUxpLink } from "./photoshopUxpLink.ts";

const linkWith = () => {
  const sent: string[] = [];
  const link = new PhotoshopUxpLink(new Logger("test"));
  return { link, sent, socket: { send: (data: string) => sent.push(data) } };
};

void test("nothing is sent while no plugin is connected", () => {
  const { link } = linkWith();
  assert.equal(link.connected, false);
  assert.equal(link.set(100, 0), false);
  assert.equal(link.requestRead(), false);
  assert.equal(link.read(), null);
});

void test("a connecting plugin is asked for the current brush", () => {
  const { link, sent, socket } = linkWith();
  link.attach("a", socket);
  assert.equal(link.connected, true);
  assert.deepEqual(sent.map((s) => JSON.parse(s) as unknown), [{ type: "read" }]);
});

void test("a reported brush is clamped and wrapped", () => {
  const { link, socket } = linkWith();
  link.attach("a", socket);
  link.handle({ type: "brush", diameter: 9000.4, angle: -90 });
  assert.deepEqual(link.read(), { brushSize: 5000, brushAngle: 270 });
});

void test("a brush message without values reports nothing usable", () => {
  const { link, socket } = linkWith();
  link.attach("a", socket);
  link.handle({ type: "brush", diameter: 100, angle: 0 });
  link.handle({ type: "brush" });
  assert.equal(link.read(), null);
});

void test("a set carries both fields, because Photoshop resets the one it is not given", () => {
  const { link, sent, socket } = linkWith();
  link.attach("a", socket);
  sent.length = 0;
  assert.equal(link.set(137, 42), true);
  assert.deepEqual(JSON.parse(String(sent[0])), { type: "set", diameter: 137, angle: 42 });
});

void test("losing the plugin clears the brush and notifies", () => {
  const { link, socket } = linkWith();
  const seen: unknown[] = [];
  link.onChange((b) => seen.push(b));
  link.attach("a", socket);
  link.handle({ type: "brush", diameter: 100, angle: 0 });
  link.detach("a");
  assert.equal(link.connected, false);
  assert.equal(link.read(), null);
  assert.deepEqual(seen, [{ brushSize: 100, brushAngle: 0 }, null]);
});

void test("an unchanged brush does not notify twice", () => {
  const { link, socket } = linkWith();
  let calls = 0;
  link.onChange(() => calls++);
  link.attach("a", socket);
  link.handle({ type: "brush", diameter: 100, angle: 0 });
  link.handle({ type: "brush", diameter: 100.2, angle: 0 });
  assert.equal(calls, 1);
});
