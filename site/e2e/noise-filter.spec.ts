import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { runInNewContext } from "node:vm";

type NoiseApi = typeof import("../src/lib/noiseFilter") & typeof import("livekit-client");
declare global { interface Window {
  noiseTest: NoiseApi;
  voiceSettingsTest: { mount(): () => void };
} }

let bundle: string;
let settingsBundle: string;
let assetServer: Server;
let audioTestOrigin: string;
const microphoneFile = path.resolve("tmp", `noise-transients-${process.pid}.wav`);
test.use({ permissions: ["microphone"], launchOptions: { channel: "msedge", args: [
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-audio-capture=${microphoneFile}`,
] } });
test.beforeAll(async () => {
  // A looping microphone fixture with short key clicks and low desk thumps.
  const sampleRate = 48000;
  const samples = sampleRate * 6;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  let seed = 42;
  for (let i = 0; i < samples; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const noise = seed / 4294967296 - 0.5;
    const time = i / sampleRate;
    const key = time % 0.28;
    const thump = time % 1.5;
    const value = noise * 0.02 +
      (key < 0.025 ? noise * 1.2 * Math.exp(-key * 180) : 0) +
      (thump < 0.15 ? 0.6 * Math.sin(thump * 2 * Math.PI * 90) * Math.exp(-thump * 35) : 0);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
  }
  await mkdir(path.dirname(microphoneFile), { recursive: true });
  await writeFile(microphoneFile, wav);
  const result = await build({
    stdin: {
      contents: 'export * from "./src/lib/noiseFilter"; export { LocalAudioTrack } from "livekit-client";',
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: "iife", globalName: "noiseTest", platform: "browser",
  });
  bundle = result.outputFiles[0].text;
  const settingsResult = await build({
    stdin: {
      contents: `import { createElement } from "react";
        import { createRoot } from "react-dom/client";
        import { VoiceSettings } from "./src/components/chat/VoiceSettings";
        export function mount() {
          const root = createRoot(document.body.appendChild(document.createElement("div")));
          root.render(createElement(VoiceSettings));
          return () => root.unmount();
        }`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: "iife", globalName: "voiceSettingsTest", platform: "browser",
  });
  settingsBundle = settingsResult.outputFiles[0].text;
  // Chromium AudioWorklet module requests bypass Playwright routing. Serve the
  // real assets so these tests also work without a running Next.js server.
  assetServer = createServer(async (request, response) => {
    const name = new URL(request.url || "/", "http://localhost").pathname;
    const asset = /^\/audio\/dtln-0\.1\.1\/(output\.js|worker\.js|runtime\.wasm|model-[12]\.tflite)$/.exec(name)?.[1];
    if (!asset) {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<title>DTLN audio test</title>");
      return;
    }
    try {
      const body = await readFile(path.join(process.cwd(), "public/audio/dtln-0.1.1", asset));
      response.writeHead(200, { "Content-Type": asset.endsWith("js") ? "text/javascript" : "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => assetServer.listen(0, "127.0.0.1", resolve));
  const address = assetServer.address();
  if (!address || typeof address === "string") throw new Error("Audio test server failed");
  audioTestOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  assetServer?.closeAllConnections();
  await new Promise<void>((resolve) => assetServer ? assetServer.close(() => resolve()) : resolve());
  await rm(microphoneFile, { force: true });
});

test("real capture keeps browser suppression before DTLN and reduces typing and thumps", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.noiseTest;
    api.setNoiseFilterMode("high", false);
    const { filter } = await api.captureFilteredMic();
    const browserNs = filter.sourceTrack.getSettings().noiseSuppression;
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(new MediaStream([filter.outputTrack])).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const measure = async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      let energy = 0;
      let peak = 0;
      for (let frame = 0; frame < 125; frame++) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        analyser.getFloatTimeDomainData(data);
        for (const value of data) {
          energy += value * value;
          peak = Math.max(peak, Math.abs(value));
        }
      }
      return { rms: Math.sqrt(energy / (125 * data.length)), peak };
    };
    try {
      const enabled = await measure();
      api.setNoiseFilterMode("off", false);
      await filter.setEnabled(false);
      const disabled = await measure();
      const disabledConstraints = filter.sourceTrack.getConstraints();
      api.setNoiseFilterMode("high", false);
      await filter.setEnabled(true);
      return { enabled, disabled, browserNs, disabledConstraints, reenabledNs: filter.sourceTrack.getConstraints().noiseSuppression, kind: filter.kind };
    } finally {
      await api.stopNoiseFilter(filter);
      await ctx.close();
    }
  });
  console.log("Typing/thumps:", result);
  expect(result.kind).toBe("dtln");
  expect(result.browserNs).toBe(true);
  // Chromium can retain the initial getSettings value after applyConstraints.
  expect(result.disabledConstraints.noiseSuppression).toBe(false);
  expect(result.reenabledNs).toBe(true);
  expect(result.disabled.rms).toBeGreaterThan(0.005);
  expect(result.enabled.rms).toBeLessThan(result.disabled.rms * 0.5);
  expect(result.enabled.peak).toBeLessThan(result.disabled.peak * 0.7);
});

test("a late denoised frame does not leak raw keyboard noise", async () => {
  type Port = { onmessage?: (event: { data: unknown }) => void; postMessage(data: unknown): void; start(): void };
  let Output: new () => { port: Port; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
  runInNewContext(await readFile("src/audio/dtln.worklet.js", "utf8"), {
    sampleRate: 16000,
    AudioWorkletProcessor: class { port: Port = { postMessage() {}, start() {} }; },
    registerProcessor: (_name: string, processor: typeof Output) => { Output = processor; },
  });
  const node = new Output!();
  const worker: Port = { postMessage() {}, start() {} };
  node.port.onmessage!({ data: { type: "worker", port: worker } });
  node.port.onmessage!({ data: { type: "enabled", enabled: true } });
  let leakedPeak = 0;
  for (let sequence = 0; sequence < 40; sequence++) {
    // The first few denoised blocks arrive; then the Worker stalls briefly.
    if (sequence >= 8 && sequence < 16) {
      worker.onmessage!({ data: { sequence: sequence - 8, samples: new Float32Array(128) } });
    }
    const output = new Float32Array(128);
    node.process([[new Float32Array(128).fill(0.8)]], [[output]]);
    if (sequence >= 20) for (const value of output) leakedPeak = Math.max(leakedPeak, Math.abs(value));
  }
  expect(leakedPeak).toBeLessThan(0.001);
});

test("settings meter follows the filtered signal and releases capture on close", async ({ page }) => {
  await page.addScriptTag({ content: settingsBundle });
  await page.evaluate(() => {
    window.noiseTest.setNoiseFilterMode("off", false);
    const tracks: MediaStreamTrack[] = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await getUserMedia(options);
      tracks.push(...stream.getTracks());
      return stream;
    };
    Object.assign(window, { meterTest: { tracks, unmount: window.voiceSettingsTest.mount() } });
  });
  const meter = page.locator(".voice-settings__meter-fill");
  const maxMeter = () => meter.evaluate(async (element) => {
    let peak = 0;
    for (let i = 0; i < 75; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      peak = Math.max(peak, parseFloat((element as HTMLElement).style.width) || 0);
    }
    return peak;
  });
  await expect.poll(maxMeter).toBeGreaterThan(40);
  const offPeak = await maxMeter();
  await page.getByRole("switch", { name: "Шумоподавление DTLN" }).click();
  await expect.poll(maxMeter).toBeLessThan(offPeak * 0.8);
  const result = await page.evaluate(() => {
    const state = (window as unknown as { meterTest: { tracks: MediaStreamTrack[]; unmount(): void } }).meterTest;
    const captures = state.tracks.length;
    state.unmount();
    return { captures, stopped: state.tracks.every((track) => track.readyState === "ended") };
  });
  expect(result).toEqual({ captures: 1, stopped: true });
});

test.beforeEach(async ({ page }) => {
  await page.route("**/dtln-test", (route) => route.fulfill({ contentType: "text/html", body: "<title>DTLN audio test</title>" }));
  await page.context().route("**/audio/dtln-0.1.1/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({
      contentType: name.endsWith("wasm") ? "application/wasm" : "text/javascript",
      body: await readFile(path.join(process.cwd(), "public/audio/dtln-0.1.1", name)),
    });
  });
  await page.goto(`${audioTestOrigin}/dtln-test`);
  await page.addScriptTag({ content: bundle });
});

test("DTLN loads real models, suppresses noise and toggles without replacing capture", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.noiseTest;
    api.setBrowserNsStrength(0, false);
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    const input = ctx.createMediaStreamDestination();
    const buffer = ctx.createBuffer(1, 16000, 16000);
    let seed = 42;
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      samples[i] = (seed / 4294967296 - 0.5) * 0.15;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(input);
    source.start();
    const raw = input.stream.getAudioTracks()[0];
    const session = await api.startNoiseFilter(raw, "high");
    const trackId = session.outputTrack.id;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(new MediaStream([session.outputTrack])).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const rms = async () => {
      await new Promise((r) => setTimeout(r, 800));
      analyser.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    };
    const wet = await rms();
    await session.setEnabled(false);
    const dry = await rms();
    await Promise.all([session.setEnabled(true), session.setEnabled(false), session.setEnabled(true)]);
    const enabled = session.enabled;
    const kind = session.kind;
    const sameTrack = session.outputTrack.id === trackId;
    const rawLive = raw.readyState;
    await api.stopNoiseFilter(session);
    await api.stopNoiseFilter(session);
    source.stop();
    await ctx.close();
    return { wet, dry, enabled, kind, sameTrack, rawLive, stopped: raw.readyState, outputStopped: session.outputTrack.readyState };
  });
  console.log("DTLN signal:", result);
  expect(result.kind).toBe("dtln");
  expect(result.dry).toBeGreaterThan(0.02);
  expect(result.wet).toBeLessThan(result.dry * 0.5);
  expect(result.enabled).toBe(true);
  expect(result.sameTrack).toBe(true);
  expect(result.rawLive).toBe("live");
  expect(result.stopped).toBe("ended");
  expect(result.outputStopped).toBe("ended");
});

test("missing model runtime falls back without ending the microphone", async ({ page }) => {
  await page.context().route("**/runtime.wasm", (route) => route.fulfill({ status: 503, body: "unavailable" }));
  const result = await page.evaluate(async () => {
    const ctx = new AudioContext();
    const raw = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    const session = await window.noiseTest.startNoiseFilter(raw, "high");
    const result = { kind: session.kind, enabled: session.enabled, state: raw.readyState };
    await window.noiseTest.stopNoiseFilter(session);
    await ctx.close();
    return result;
  });
  expect(result).toEqual({ kind: "browser", enabled: true, state: "live" });
});

test("off mode stays off and does not load DTLN until enabled", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/audio/")) requests.push(request.url()); });
  const result = await page.evaluate(async () => {
    const ctx = new AudioContext();
    const raw = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    raw.enabled = false;
    const session = await window.noiseTest.startNoiseFilter(raw, "off");
    const result = { enabled: session.enabled, muted: !session.outputTrack.enabled };
    await window.noiseTest.stopNoiseFilter(session);
    await ctx.close();
    return result;
  });
  expect(result).toEqual({ enabled: false, muted: true });
  expect(requests.every((url) => url.endsWith("/output.js"))).toBe(true);
});

test("LiveKit fallback teardown does not stop its original capture track", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.noiseTest;
    const ctx = new AudioContext();
    const workletPrototype = Object.getPrototypeOf(ctx.audioWorklet);
    const addModule = workletPrototype.addModule;
    workletPrototype.addModule = async () => { throw new Error("AudioWorklet unavailable"); };
    const raw = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    const track = new api.LocalAudioTrack(raw, undefined, true, ctx);
    const session = await api.attachNoiseFilterToLiveKitTrack(track, "high");
    workletPrototype.addModule = addModule;
    await api.stopNoiseFilter(session);
    const result = { kind: session.kind, rawState: raw.readyState, restored: track.mediaStreamTrack === raw };
    track.stop();
    await ctx.close();
    return result;
  });
  expect(result).toEqual({ kind: "browser", rawState: "live", restored: true });
});

test("LiveKit processor preserves disabled state and updates raw source after restart", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.noiseTest;
    api.setBrowserNsStrength(0, false);
    const ctx = new AudioContext({ sampleRate: 48000 });
    const raw = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    const replacement = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    const track = new api.LocalAudioTrack(raw, undefined, true, ctx);
    const pc = new RTCPeerConnection();
    track.sender = pc.addTrack(raw);
    const session = await api.attachNoiseFilterToLiveKitTrack(track, "high");
    await session.setEnabled(false);
    const previousOutput = session.outputTrack;
    await track.replaceTrack(replacement, true);
    const result = {
      kind: session.kind, enabled: session.enabled,
      rawUpdated: session.sourceTrack === replacement,
      outputUpdated: session.outputTrack === track.mediaStreamTrack && previousOutput !== session.outputTrack,
      previousStopped: previousOutput.readyState,
    };
    await api.stopNoiseFilter(session);
    const stillLive = replacement.readyState;
    raw.stop();
    replacement.stop();
    track.stop();
    pc.close();
    await ctx.close();
    return { ...result, stillLive };
  });
  expect(result).toEqual({ kind: "dtln", enabled: false, rawUpdated: true, outputUpdated: true, previousStopped: "ended", stillLive: "live" });
});

test("audio remains continuous during toggles and a busy UI thread", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const api = window.noiseTest;
    api.setBrowserNsStrength(0, false);
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    const input = ctx.createMediaStreamDestination();
    const tone = ctx.createOscillator();
    tone.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.value = 0.1;
    tone.connect(gain).connect(input);
    tone.start();
    // Observe the filter's render output directly. A second MediaStream bridge
    // adds its own clock correction and would confound the DSP continuity check.
    const NativeWorkletNode = window.AudioWorkletNode;
    let renderNode: AudioWorkletNode | undefined;
    window.AudioWorkletNode = class extends NativeWorkletNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        // Capture the native node for a direct render-thread measurement.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        if (name === "pulse-dtln-output") renderNode = this;
      }
    };
    const session = await api.startNoiseFilter(input.stream.getAudioTracks()[0], "high");
    window.AudioWorkletNode = NativeWorkletNode;
    if (!renderNode || session.kind !== "dtln") throw new Error("DTLN did not start");
    const renderContext = renderNode.context as AudioContext;
    const moduleUrl = URL.createObjectURL(new Blob([`
      class Capture extends AudioWorkletProcessor {
        samples = new Float32Array(48000); offset = 0;
        process(inputs) {
          const input = inputs[0]?.[0];
          if (!input) return true;
          const size = Math.min(input.length, this.samples.length - this.offset);
          this.samples.set(input.subarray(0, size), this.offset);
          this.offset += size;
          if (this.offset === this.samples.length) {
            this.port.postMessage(this.samples, [this.samples.buffer]);
            return false;
          }
          return true;
        }
      }
      registerProcessor('capture-test', Capture);
    `], { type: "text/javascript" }));
    await renderContext.audioWorklet.addModule(moduleUrl);
    URL.revokeObjectURL(moduleUrl);
    const tap = new AudioWorkletNode(renderContext, "capture-test");
    const capture = new Promise<Float32Array>((resolve) => { tap.port.onmessage = (event) => resolve(event.data); });
    renderNode.connect(tap).connect(renderContext.destination);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(600);
    for (const enabled of [false, true, false, true]) {
      await session.setEnabled(enabled);
      await wait(180);
    }
    const blockedUntil = performance.now() + 300;
    while (performance.now() < blockedUntil) { /* Simulate an expensive UI render. */ }
    const samples = await capture;
    let maxJump = 0;
    let jumpIndex = 0;
    let zeroRun = 0;
    let longestZeroRun = 0;
    let finite = true;
    for (let i = 8000; i < samples.length; i++) {
      finite &&= Number.isFinite(samples[i]);
      const jump = Math.abs(samples[i] - samples[i - 1]);
      if (jump > maxJump) { maxJump = jump; jumpIndex = i; }
      zeroRun = samples[i] === 0 ? zeroRun + 1 : 0;
      longestZeroRun = Math.max(longestZeroRun, zeroRun);
    }
    // DTLN can legitimately silence a steady test tone. Verify that bypass
    // still carries audio after the toggles, rather than requiring noise to leak.
    await session.setEnabled(false);
    const analyser = renderContext.createAnalyser();
    renderNode.connect(analyser);
    await wait(250);
    const bypass = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(bypass);
    const bypassRms = Math.sqrt(bypass.reduce((sum, value) => sum + value * value, 0) / bypass.length);
    await api.stopNoiseFilter(session);
    tone.stop();
    tap.disconnect();
    await ctx.close();
    return { maxJump, jumpIndex, nearJump: Array.from(samples.slice(jumpIndex - 4, jumpIndex + 5)), longestZeroRun, finite, bypassRms };
  });
  console.log("DTLN continuity:", result);
  expect(result.finite).toBe(true);
  expect(result.maxJump).toBeLessThan(0.03);
  expect(result.bypassRms).toBeGreaterThan(0.05);
});
