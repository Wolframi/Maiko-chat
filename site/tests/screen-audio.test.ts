import assert from "node:assert/strict";
import test from "node:test";
import { captureScreenShare, patchOpusSdp, splitCallAudioTracks } from "../src/lib/webrtcMedia";

function audio(id: string, hint = "") {
  return { id, kind: "audio", contentHint: hint, readyState: "live" } as MediaStreamTrack;
}

test("screen audio alone is not routed to voice; explicit roles override order and stale hints", () => {
  const music = audio("screen", "music");
  const mic = audio("mic");
  const known = new Set<string>();
  assert.deepEqual(splitCallAudioTracks([music], known), { voice: [], screen: [music] });
  assert.deepEqual(splitCallAudioTracks([music, mic], known), { voice: [mic], screen: [music] });
  music.contentHint = "";
  assert.deepEqual(splitCallAudioTracks([music], new Set(), new Set([music.id])), { voice: [], screen: [music] });
  assert.deepEqual(splitCallAudioTracks([mic, music], known, new Set()), { voice: [mic, music], screen: [] });
  assert.equal(known.size, 0);
  const ended = { ...music, readyState: "ended" } as MediaStreamTrack;
  assert.deepEqual(splitCallAudioTracks([ended, mic], new Set([ended.id])), { voice: [mic], screen: [] });
  assert.deepEqual(splitCallAudioTracks([mic, music], new Set()), { voice: [mic], screen: [music] });
});

test("Opus tuning uses roles even when the only audio section is screen audio", () => {
  const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:screen\r\na=rtpmap:111 opus/48000/2\r\n";
  const screen = patchOpusSdp(sdp, new Set(["screen"]));
  assert.match(screen, /maxaveragebitrate=128000/);
  assert.match(screen, /(?:;| )stereo=1/);
  assert.match(screen, /usedtx=0/);
  const voice = patchOpusSdp(sdp, new Set());
  assert.match(voice, /maxaveragebitrate=64000/);
  assert.match(voice, /usedtx=1/);
});

test("window audio remains live with a warning when isolation is unsupported; call tabs still exclude echo", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalWindow = globalThis.window;
  let stopped = false;
  let callTab = false;
  const listeners = new Map<string, () => void>();
  const sound = {
    ...audio("system"), stop() { stopped = true; },
    getSettings: () => ({ restrictOwnAudio: false }),
    applyConstraints: async () => { throw new Error("unsupported"); },
  } as unknown as MediaStreamTrack;
  const video = {
    kind: "video", getSettings: () => ({ displaySurface: "window" }),
    getCaptureHandle: () => callTab ? { origin: "http://localhost", handle: "mayko-call-audio" } : null,
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as MediaStreamTrack;
  let tracks = [video, sound];
  const stream = { getTracks: () => tracks, getVideoTracks: () => [video],
    getAudioTracks: () => tracks.filter(track => track.kind === "audio"),
    removeTrack: (track: MediaStreamTrack) => { tracks = tracks.filter(item => item !== track); },
  } as unknown as MediaStream;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    userAgent: "Chrome", mediaDevices: { getDisplayMedia: async () => stream },
  } });
  globalThis.window = { location: { origin: "http://localhost" } } as Window & typeof globalThis;
  try {
    const warnings: string[] = [];
    assert.equal(await captureScreenShare({ onAudioUnavailable: message => warnings.push(message) }), stream);
    assert.deepEqual(stream.getAudioTracks(), [sound]);
    assert.equal(stopped, false);
    assert.equal(sound.contentHint, "music");
    assert.match(warnings[0], /звук окна транслируется/);
    callTab = true;
    listeners.get("capturehandlechange")?.();
    assert.equal(stopped, true);
    assert.equal(stream.getAudioTracks().length, 0);
    assert.match(warnings.at(-1)!, /Звук вкладки со звонком не передаётся/);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
    globalThis.window = originalWindow;
  }
});
