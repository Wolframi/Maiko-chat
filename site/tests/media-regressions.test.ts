import assert from "node:assert/strict";
import { test } from "node:test";
import { pickCameraStream, pickScreenStream, callNetworkLevel } from "../src/lib/webrtcMedia";
import { peaksFromAudioUrl } from "../src/lib/waveform";

test("camera and screen keep their identity through audio changes and stream wrappers", () => {
  const original = globalThis.MediaStream;
  class Stream {
    constructor(private tracks: MediaStreamTrack[]) {}
    getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  }
  globalThis.MediaStream = Stream as unknown as typeof MediaStream;
  try {
    const camera = { kind: "video", readyState: "live", enabled: true, contentHint: "motion", getSettings: () => ({}) } as MediaStreamTrack;
    const screen = { kind: "video", readyState: "live", enabled: true, contentHint: "detail", getSettings: () => ({}) } as MediaStreamTrack;
    const mic = { kind: "audio", enabled: true } as MediaStreamTrack;
    const first = new MediaStream([camera, screen, mic]);
    const cameraView = pickCameraStream(first);
    const screenView = pickScreenStream(first);
    mic.enabled = false;
    assert.equal(pickCameraStream(new MediaStream([camera, screen, mic])), cameraView);
    assert.equal(pickScreenStream(new MediaStream([screen, camera])), screenView);
    assert.equal(pickScreenStream(new MediaStream([screen])), screenView);
    assert.notEqual(cameraView, screenView);
    assert.deepEqual(cameraView?.getVideoTracks(), [camera]);
  } finally { globalThis.MediaStream = original; }
});

test("waveform requests deduplicate rotating signatures and survive one cancelled consumer", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://localhost:3000/", origin: "http://localhost:3000" } } as Window & typeof globalThis;
  let requests = 0;
  let resolve!: (response: Response) => void;
  globalThis.fetch = async (url) => {
    requests++;
    assert.equal(new URL(String(url)).searchParams.get("waveform"), "1");
    return new Promise<Response>((done) => { resolve = done; });
  };
  try {
    const cancelled = new AbortController();
    const a = peaksFromAudioUrl("/uploads/test.webm?sig=old", 160, cancelled.signal);
    const b = peaksFromAudioUrl("/uploads/test.webm?sig=new", 160);
    await new Promise((done) => setImmediate(done));
    cancelled.abort();
    resolve(new Response(JSON.stringify({ peaks: Array(160).fill(.5), duration: 12 }), { headers: { "content-type": "application/json" } }));
    assert.equal(await a, null);
    assert.equal((await b)?.duration, 12);
    assert.equal((await peaksFromAudioUrl("/uploads/test.webm?sig=third", 160))?.peaks.length, 160);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});

test("poor loss or jitter cannot be presented as good just because RTT is low", () => {
  const healthy = { rttMs: 30, jitterMs: 5, lossPct: 0, availableBitrate: 2_000_000 };
  assert.equal(callNetworkLevel(healthy), "good");
  assert.equal(callNetworkLevel({ ...healthy, jitterMs: 100 }), "poor");
  assert.equal(callNetworkLevel({ ...healthy, lossPct: 15 }), "poor");
  assert.equal(callNetworkLevel({ ...healthy, rttMs: 300 }), "ok");
});
