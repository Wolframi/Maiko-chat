import assert from "node:assert/strict";
import { test } from "node:test";
import { findHookStartSec, RINGTONE_CLIP_SEC } from "../src/server/ringtoneHook";

const rate = 1000;
function track(seconds: number, level: (time: number) => number) {
  return Float32Array.from({ length: seconds * rate }, (_, i) =>
    Math.sin(i * Math.PI * 0.12) * level(i / rate));
}

test("automatic ringtone uses the strongest sustained 30 seconds beyond the first 90 seconds", () => {
  const samples = track(180, time => time >= 120 && time < 155 ? 0.8 : 0.03);
  const start = findHookStartSec(samples, rate);
  assert.equal(RINGTONE_CLIP_SEC, 30);
  assert.ok(start >= 119.9 && start <= 125.1, `Selected ${start}`);
  assert.ok(start + RINGTONE_CLIP_SEC <= 180);
});

test("a short loud spike does not beat a sustained energetic section", () => {
  const samples = track(120, time => time >= 10 && time < 10.2 ? 1 : time >= 60 && time < 95 ? 0.5 : 0.02);
  const start = findHookStartSec(samples, rate);
  assert.ok(start >= 59.9 && start <= 65.1, `Selected ${start}`);
});

test("short or silent tracks start at zero; the final energetic section keeps a full clip", () => {
  assert.equal(findHookStartSec(new Float32Array(60 * rate), rate), 0);
  assert.equal(findHookStartSec(track(20, () => 0.5), rate), 0);
  assert.equal(findHookStartSec(new Float32Array(), rate), 0);
  const samples = track(100, time => time > 90 ? 0.8 : 0.03);
  const start = findHookStartSec(samples, rate);
  assert.ok(start >= 69.8 && start <= 70);
});
