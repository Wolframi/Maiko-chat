import { test } from "node:test";
import assert from "node:assert/strict";
import { getLiveKit, loadLiveKit } from "../src/lib/liveKitLoader";

test("LiveKit stays unloaded until requested; concurrent callers share a load and cancel independently", async () => {
  assert.throws(getLiveKit, /ещё не загружен/);
  const first = loadLiveKit(), second = loadLiveKit();
  assert.equal(first, second);
  const controller = new AbortController();
  const cancelled = loadLiveKit(controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const sdk = await first;
  assert.equal(getLiveKit(), sdk);
  assert.equal(await second, sdk);
  assert.equal(sdk.ConnectionQuality.Unknown, "unknown");
  assert.equal(sdk.ConnectionQuality.Good, "good");
  assert.equal(sdk.ConnectionQuality.Lost, "lost");
  assert.equal(typeof sdk.Room, "function");
});
