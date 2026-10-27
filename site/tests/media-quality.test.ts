import assert from "node:assert/strict";
import test from "node:test";
import { applyAudioSenderParams, applyVideoSenderParams, videoQualityForCall, readMediaRtt, isScreenCaptureCancelled } from "../src/lib/webrtcMedia";

test("ping uses the selected media transport and ignores stale pairs and invalid stats", () => {
  const report = (entries: Record<string, unknown>[]) => new Map(entries.map((entry, index) =>
    [String(entry.id ?? index), entry])) as unknown as RTCStatsReport;
  const stale = { id: "stale", type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.8 };
  const active = { id: "active", type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.0424 };
  const transport = { type: "transport", selectedCandidatePairId: "active" };
  assert.equal(readMediaRtt(report([stale, active, transport])), 42);
  assert.equal(readMediaRtt(report([{ ...active, currentRoundTripTime: 0 }, transport])), 0);
  assert.equal(readMediaRtt(report([{ type: "remote-inbound-rtp", roundTripTime: 0.075 }])), 75);
  assert.equal(readMediaRtt(report([{ ...active, nominated: true, currentRoundTripTime: NaN }])), null);
  assert.equal(readMediaRtt(report([{ ...active, nominated: true, currentRoundTripTime: -1 }])), null);
  assert.equal(readMediaRtt(report([])), null);
});

test("capture cancellation is distinct from device and publication errors", () => {
  for (const name of ["AbortError", "NotAllowedError", "PermissionDeniedError"]) {
    assert.equal(isScreenCaptureCancelled({ name }), true);
  }
  for (const error of [{ name: "NotReadableError" }, { name: "NotFoundError" }, new Error("failed"), null]) {
    assert.equal(isScreenCaptureCancelled(error), false);
  }
});

test("presenter changing tabs preserves screen quality at every network tier", () => {
  for (const level of ["good", "ok", "poor"] as const) {
    assert.deepEqual(videoQualityForCall("screen", level, true), videoQualityForCall("screen", level));
  }
  const good = videoQualityForCall("screen", "good");
  const ok = videoQualityForCall("screen", "ok");
  assert.equal(ok.scale, good.scale); // Keep text legible before reducing resolution.
  assert.ok(ok.maxFramerate < good.maxFramerate);
  assert.ok(ok.maxBitrate < good.maxBitrate);
  assert.ok(videoQualityForCall("screen", "poor").scale > good.scale);
  assert.ok(videoQualityForCall("camera", "good", true).maxBitrate < videoQualityForCall("camera", "good").maxBitrate);
});

test("voice takes priority over video; a rejected video update is reported for retry", async () => {
  let audioParams: RTCRtpSendParameters | undefined;
  let videoParams: RTCRtpSendParameters | undefined;
  let reject = true;
  const sound = {
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (params: RTCRtpSendParameters) => { audioParams = params; },
  } as unknown as RTCRtpSender;
  const video = {
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (params: RTCRtpSendParameters) => {
      if (reject) throw new Error("negotiation in progress");
      videoParams = params;
    },
  } as unknown as RTCRtpSender;
  const good = videoQualityForCall("screen", "good");
  const options = { ...good, maintainResolution: true };
  assert.equal(await applyVideoSenderParams(video, options), false);
  reject = false;
  assert.equal(await applyVideoSenderParams(video, options), true);
  await applyAudioSenderParams(sound);
  assert.equal(audioParams!.encodings[0].priority, "high");
  assert.equal(videoParams!.encodings[0].priority, "medium");
  assert.equal(videoParams!.degradationPreference, "maintain-resolution");
});
