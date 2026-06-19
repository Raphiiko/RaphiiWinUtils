import assert from "node:assert/strict";
import test from "node:test";
import { scalarToDb } from "./channelMapper.ts";

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 0.000001, `expected ${actual} to equal ${expected}`);
}

void test("maps the Windows control scalar with a squared-amplitude audio taper", () => {
  assert.equal(scalarToDb(0, -60, 0), -60);
  assertClose(scalarToDb(0.2, -60, 0), -27.95880017344075);
  assertClose(scalarToDb(0.4, -60, 0), -15.917600346881503);
  assertClose(scalarToDb(0.6, -60, 0), -8.873949984654253);
  assertClose(scalarToDb(0.8, -60, 0), -3.876400520322257);
  assert.equal(scalarToDb(1, -60, 0), 0);
});

void test("clamps endpoint scalars outside the normalized range", () => {
  assert.equal(scalarToDb(-1, -60, 0), -60);
  assert.equal(scalarToDb(2, -60, 0), 0);
});

void test("respects non-default Matrix gain ranges", () => {
  assertClose(scalarToDb(0.25, -40, 8), -16.082399653118497);
  assertClose(scalarToDb(0.75, -40, 8), 3.002450321273423);
});
