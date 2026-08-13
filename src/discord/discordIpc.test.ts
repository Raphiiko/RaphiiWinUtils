import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrames, encodeFrame, opFrame } from "./discordIpc.ts";

void test("writes the opcode and payload length as little-endian header fields", () => {
  const frame = encodeFrame(opFrame, { cmd: "GET_VOICE_SETTINGS" });
  assert.equal(frame.readInt32LE(0), opFrame);
  assert.equal(frame.readInt32LE(4), frame.length - 8);
});

void test("decodes several frames from one chunk", () => {
  const chunk = Buffer.concat([
    encodeFrame(opFrame, { cmd: "SET_VOICE_SETTINGS", nonce: "one" }),
    encodeFrame(opFrame, { evt: "VOICE_SETTINGS_UPDATE", data: { mute: true } })
  ]);

  const { frames, rest } = decodeFrames(chunk);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.nonce, "one");
  assert.deepEqual(frames[1]?.data, { mute: true });
  assert.equal(rest.length, 0);
});

void test("keeps a partial frame until the rest of it arrives", () => {
  const complete = encodeFrame(opFrame, { cmd: "AUTHENTICATE", nonce: "two" });
  const split = complete.length - 4;

  const first = decodeFrames(complete.subarray(0, split));
  assert.equal(first.frames.length, 0);
  assert.equal(first.rest.length, split);

  const second = decodeFrames(Buffer.concat([first.rest, complete.subarray(split)]));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0]?.nonce, "two");
  assert.equal(second.rest.length, 0);
});
