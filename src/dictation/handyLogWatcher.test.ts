import assert from "node:assert/strict";
import test from "node:test";
import { parseHandyLogLine } from "./handyLogWatcher.ts";

void test("detects the start of a Handy dictation", () => {
  assert.equal(
    parseHandyLogLine(
      "[2026-08-13][10:29:38][handy_app_lib::actions][DEBUG] TranscribeAction::start called for binding: transcribe"
    ),
    "start"
  );
});

void test("detects the end of a Handy dictation", () => {
  assert.equal(
    parseHandyLogLine(
      "[2026-08-13][10:29:49][handy_app_lib::actions][DEBUG] TranscribeAction::stop called for binding: transcribe"
    ),
    "stop"
  );
});

void test("treats a cancelled dictation as a stop", () => {
  assert.equal(
    parseHandyLogLine(
      "[2026-08-13][10:29:49][handy_app_lib::utils][INFO] Initiating operation cancellation..."
    ),
    "stop"
  );
});

void test("ignores the completion lines that follow a dictation", () => {
  assert.equal(
    parseHandyLogLine(
      "[2026-08-13][10:29:38][handy_app_lib::actions][DEBUG] TranscribeAction::start completed in 9.907ms"
    ),
    undefined
  );
  assert.equal(
    parseHandyLogLine(
      "[2026-08-13][10:29:49][handy_app_lib::actions][DEBUG] TranscribeAction::stop completed in 7.3931ms"
    ),
    undefined
  );
  assert.equal(
    parseHandyLogLine(
      "[2026-08-13][10:29:50][handy_app_lib::actions][DEBUG] Text pasted successfully in 223.6621ms"
    ),
    undefined
  );
});
