import assert from "node:assert/strict";
import test from "node:test";
import { parseMatrixSlots, planSlotRecovery, type StalledSlot } from "./matrixSlotRecovery.ts";

void test("parses a Matrix slot status reply", () => {
  const slots = parseMatrixSlots(
    'Slot(WIN1.OUT).Device.MME = "Headphones (Nothing Ear (a))";Slot(WIN1.OUT).Running = 1;' +
      'Slot(WIN5.IN).Device.WDM = "VD Input (Virtual Desktop Audio)";Slot(WIN5.IN).Running = 0;' +
      'Slot(WIN2.OUT).Device = "";Slot(WIN2.OUT).Running = 0;'
  );

  assert.deepEqual(slots, [
    { slot: "WIN1.OUT", driver: "MME", device: "Headphones (Nothing Ear (a))", running: true },
    { slot: "WIN5.IN", driver: "WDM", device: "VD Input (Virtual Desktop Audio)", running: false },
    { slot: "WIN2.OUT", driver: undefined, device: "", running: false }
  ]);
});

void test("re-assigns a returned output, restarts once, and reports recovery", () => {
  const output = {
    slot: "WIN1.OUT",
    driver: "WDM",
    device: "Bigscreen Beyond (USB-C)",
    running: false
  };
  const stalled = new Map<string, StalledSlot>();
  const plan = (now: number, names = ["Bigscreen Beyond (USB-C)"], running = false) =>
    planSlotRecovery([{ ...output, running }], names, stalled, now, -Infinity).map(
      (action) => action.kind
    );

  assert.deepEqual(plan(0, []), [], "absent output is left alone");
  assert.deepEqual(plan(0), [], "first sighting is a grace tick");
  assert.deepEqual(plan(2_000), ["reassign"]);
  assert.deepEqual(plan(3_000), [], "backoff");
  assert.deepEqual(plan(4_000), ["restart"]);
  assert.deepEqual(plan(8_000), ["reassign"], "only one restart per stall");
  assert.deepEqual(plan(9_000, undefined, true), ["recovered"]);
  assert.equal(stalled.size, 0);
});

void test("re-assigns an input slot without restarting the engine", () => {
  const input = {
    slot: "WIN3.IN",
    driver: "WDM",
    device: "Beyond Mic (2- Beyond)",
    running: false
  };
  const stalled = new Map<string, StalledSlot>();
  const kinds = [0, 2_000, 4_000, 8_000].flatMap((now) =>
    planSlotRecovery([input], [], stalled, now, -Infinity).map((action) => action.kind)
  );

  assert.deepEqual(kinds, ["reassign", "reassign", "reassign"]);
});
