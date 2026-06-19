import assert from "node:assert/strict";
import test from "node:test";
import { scalarToDb } from "./channelMapper.ts";

void test("maps the audio-tapered Windows scalar linearly across the Matrix dB range", () => {
  assert.equal(scalarToDb(0, -60, 0), -60);
  assert.equal(scalarToDb(0.01, -60, 0), -59.4);
  assert.equal(scalarToDb(0.1, -60, 0), -54);
  assert.equal(scalarToDb(0.5, -60, 0), -30);
  assert.equal(scalarToDb(0.9, -60, 0), -6);
  assert.equal(scalarToDb(1, -60, 0), 0);
});

void test("clamps endpoint scalars outside the normalized range", () => {
  assert.equal(scalarToDb(-1, -60, 0), -60);
  assert.equal(scalarToDb(2, -60, 0), 0);
});

void test("respects non-default Matrix gain ranges", () => {
  assert.equal(scalarToDb(0.25, -40, 8), -28);
  assert.equal(scalarToDb(0.75, -40, 8), -4);
});
