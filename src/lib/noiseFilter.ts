"use client";

import type { LocalAudioTrack, AudioProcessorOptions, TrackProcessor } from "livekit-client";
import { Track } from "livekit-client";
import { toast } from "sonner";
import { emitVoiceSettings, getMicDeviceId } from "@/lib/mediaDevices";

export type NoiseFilterKind = "krisp" | "rnnoise" | "browser";

export type NoiseFilterSession = {
  kind: NoiseFilterKind;
  enabled: boolean;
  outputTrack: MediaStreamTrack;
  sourceTrack: MediaStreamTrack;
  /** Stop the capture track in `stopNoiseFilter` (mesh / 1:1 / notes). */
  ownsSource: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
  stop: () => Promise<void>;
};

export async function stopNoiseFilter(session: NoiseFilterSession | null) {
  if (!session) return;
  await session.stop().catch(() => undefined);
  if (!session.ownsSource) return;
  for (const track of [session.sourceTrack, session.outputTrack]) {
    if (track.readyState === "ended") continue;
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
}

const PREF_KEY = "pulse-noise-suppression";
const KRISP_KEY = "pulse-krisp";
const BROWSER_NS_KEY = "pulse-browser-ns";
let noiseFallbackToastShown = false;
let prefsMigrated = false;

export type NoiseFilterMode = "off" | "standard" | "high";

function warnNoiseFallback(session: NoiseFilterSession, wantedNeural: boolean) {
  if (!wantedNeural || session.kind !== "browser") return;
  if (noiseFallbackToastShown) return;
  noiseFallbackToastShown = true;
  toast("Нейро-шумодав недоступен — работает браузерный");
}

function readStorage(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function parseNoiseMode(value: string | null): NoiseFilterMode {
  if (value === "off") return "off";
  if (value === "0" || value === "standard") return "standard";
  if (value === "1" || value === "high" || value === null) return "high";
  return "high";
}

function clampNsStrength(value: number) {
  if (!Number.isFinite(value)) return 70;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function migrateVoicePrefs() {
  if (prefsMigrated || typeof window === "undefined") return;
  prefsMigrated = true;
  if (readStorage(KRISP_KEY) !== null || readStorage(BROWSER_NS_KEY) !== null) {
    return;
  }
  const legacy = readStorage(PREF_KEY);
  if (legacy === null) return;
  const mode = parseNoiseMode(legacy);
  if (mode === "high") {
    writeStorage(KRISP_KEY, "1");
    writeStorage(BROWSER_NS_KEY, "70");
  } else if (mode === "standard") {
    writeStorage(KRISP_KEY, "0");
    writeStorage(BROWSER_NS_KEY, "70");
  } else {
    writeStorage(KRISP_KEY, "0");
    writeStorage(BROWSER_NS_KEY, "0");
  }
}

export function getKrispEnabled() {
  migrateVoicePrefs();
  const value = readStorage(KRISP_KEY);
  if (value === null) return true;
  return value === "1";
}

export function setKrispEnabled(enabled: boolean, emit = true) {
  migrateVoicePrefs();
  if (enabled === getKrispEnabled()) return;
  writeStorage(KRISP_KEY, enabled ? "1" : "0");
  if (emit) emitVoiceSettings({ noise: true });
}

export function getBrowserNsStrength() {
  migrateVoicePrefs();
  const raw = readStorage(BROWSER_NS_KEY);
  if (raw === null) return 70;
  return clampNsStrength(Number(raw));
}

export function setBrowserNsStrength(value: number, emit = true) {
  migrateVoicePrefs();
  const next = clampNsStrength(value);
  if (next !== getBrowserNsStrength()) {
    writeStorage(BROWSER_NS_KEY, String(next));
  }
  if (emit) emitVoiceSettings({ noise: true });
}

export function wantsBrowserNs() {
  return !getKrispEnabled() && getBrowserNsStrength() > 0;
}

export function getNoiseFilterMode(): NoiseFilterMode {
  if (getKrispEnabled()) return "high";
  if (getBrowserNsStrength() > 0) return "standard";
  return "off";
}

export function getLastNoiseFilterMode(): NoiseFilterMode {
  return getKrispEnabled() ? "high" : "standard";
}

export function setNoiseFilterMode(mode: NoiseFilterMode, emit = true) {
  if (mode === "high") {
    writeStorage(KRISP_KEY, "1");
    if (readStorage(BROWSER_NS_KEY) === null) writeStorage(BROWSER_NS_KEY, "70");
  } else if (mode === "standard") {
    writeStorage(KRISP_KEY, "0");
    if (getBrowserNsStrength() === 0) writeStorage(BROWSER_NS_KEY, "70");
  } else {
    writeStorage(KRISP_KEY, "0");
    writeStorage(BROWSER_NS_KEY, "0");
  }
  if (emit) emitVoiceSettings({ noise: true });
}

/** Overlay sparkles: Krisp on/off, independent from the built-in slider. */
export function getNoiseFilterPref(): boolean {
  return getKrispEnabled();
}

export function setNoiseFilterPref(enabled: boolean) {
  setKrispEnabled(enabled);
}

function resolveNoiseMode(mode?: NoiseFilterMode | boolean): NoiseFilterMode {
  if (mode === true) return "high";
  if (mode === false) return "off";
  if (mode) return mode;
  return getNoiseFilterMode();
}

/** Capture constraints: AEC/AGC always; browser NS when Krisp is off and the slider is above 0. */
export function audioCaptureConstraints(
  _neuralNs?: boolean,
): MediaTrackConstraints {
  const micId = getMicDeviceId();
  return {
    echoCancellation: true,
    noiseSuppression: wantsBrowserNs(),
    autoGainControl: true,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    ...(micId ? { deviceId: { ideal: micId } } : {}),
  };
}

export function setMicEnabled(
  stream: MediaStream | null,
  enabled: boolean,
  sourceTrack?: MediaStreamTrack | null,
) {
  if (sourceTrack && sourceTrack.readyState !== "ended") {
    sourceTrack.enabled = enabled;
  }
  if (!stream) return;
  for (const track of stream.getAudioTracks()) track.enabled = enabled;
}

async function enableBrowserNs(track: MediaStreamTrack) {
  try {
    await track.applyConstraints({ noiseSuppression: true });
  } catch {
    /* some devices reject mid-stream NS toggles */
  }
}

async function disableBrowserNs(track: MediaStreamTrack) {
  try {
    await track.applyConstraints({ noiseSuppression: false });
  } catch {
    /* ignore */
  }
}

type RnnoiseGraph = {
  outputTrack: MediaStreamTrack;
  setEnabled: (enabled: boolean) => void;
  stop: () => Promise<void>;
};

let rnnoiseModulePromise: Promise<{
  frameSize: number;
  createDenoiseState: () => {
    processFrame: (frame: Float32Array) => number;
    destroy: () => void;
  };
}> | null = null;

function loadRnnoise() {
  if (!rnnoiseModulePromise) {
    rnnoiseModulePromise = import("@shiguredo/rnnoise-wasm").then((mod) =>
      mod.Rnnoise.load(),
    );
  }
  return rnnoiseModulePromise;
}

async function startRnnoiseGraph(
  sourceTrack: MediaStreamTrack,
  enabled: boolean,
  audioContext?: AudioContext,
): Promise<RnnoiseGraph> {
  const rnnoise = await loadRnnoise();
  const denoise = rnnoise.createDenoiseState();
  const frameSize = rnnoise.frameSize;

  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const ctx = audioContext ?? new Ctx({ sampleRate: 48000 });
  if (ctx.state === "suspended") await ctx.resume();

  const source = ctx.createMediaStreamSource(new MediaStream([sourceTrack]));
  const dest = ctx.createMediaStreamDestination();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = enabled ? 0 : 1;
  wet.gain.value = enabled ? 1 : 0;

  const processor = ctx.createScriptProcessor(512, 1, 1);
  const pending = new Float32Array(frameSize);
  let pendingCount = 0;
  // One ScriptProcessor block of zeros: 512 in vs 480-sample RNNoise frames.
  // Keep this tiny — extra delay is heard as Krisp lag.
  const DELAY_SAMPLES = 512;
  const RING = 2048;
  const ring = new Float32Array(RING);
  let readPos = 0;
  let writePos = DELAY_SAMPLES;
  let queued = DELAY_SAMPLES;

  const resetDelay = () => {
    ring.fill(0);
    readPos = 0;
    writePos = DELAY_SAMPLES;
    queued = DELAY_SAMPLES;
  };

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    if (wet.gain.value < 0.5) {
      output.fill(0);
      pendingCount = 0;
      resetDelay();
      return;
    }
    for (let i = 0; i < input.length; i += 1) {
      pending[pendingCount] = input[i];
      pendingCount += 1;
      if (pendingCount < frameSize) continue;
      const frame = pending.slice();
      for (let j = 0; j < frameSize; j += 1) frame[j] *= 32768;
      try {
        denoise.processFrame(frame);
      } catch {
        /* wasm torn down */
      }
      for (let j = 0; j < frameSize; j += 1) {
        ring[writePos] = frame[j] / 32768;
        writePos = (writePos + 1) % RING;
        queued += 1;
      }
      pendingCount = 0;
    }
    for (let i = 0; i < output.length; i += 1) {
      if (queued > 0) {
        output[i] = ring[readPos];
        readPos = (readPos + 1) % RING;
        queued -= 1;
      } else {
        output[i] = 0;
      }
    }
  };

  source.connect(dry);
  dry.connect(dest);
  source.connect(processor);
  processor.connect(wet);
  wet.connect(dest);

  const outputTrack = dest.stream.getAudioTracks()[0];
  if (!outputTrack) throw new Error("RNNoise: нет выходного трека");

  return {
    outputTrack,
    setEnabled: (next) => {
      dry.gain.value = next ? 0 : 1;
      wet.gain.value = next ? 1 : 0;
    },
    stop: async () => {
      try {
        processor.disconnect();
        wet.disconnect();
        dry.disconnect();
        source.disconnect();
      } catch {
        /* ignore */
      }
      denoise.destroy();
      if (!audioContext) {
        try {
          await ctx.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function browserSession(
  sourceTrack: MediaStreamTrack,
  enabled: boolean,
  ownsSource = false,
): NoiseFilterSession {
  const session: NoiseFilterSession = {
    kind: "browser",
    enabled,
    outputTrack: sourceTrack,
    sourceTrack,
    ownsSource,
    setEnabled: async (next) => {
      session.enabled = next;
      if (next) await enableBrowserNs(sourceTrack);
      else await disableBrowserNs(sourceTrack);
    },
    stop: async () => {
      /* caller owns the mic track */
    },
  };
  return session;
}

async function tryKrispOnTrack(
  track: LocalAudioTrack,
  enabled: boolean,
  ownsSource = false,
): Promise<NoiseFilterSession | null> {
  try {
    const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import(
      "@livekit/krisp-noise-filter"
    );
    if (!isKrispNoiseFilterSupported()) return null;
    const processor = KrispNoiseFilter({
      quality: "low",
      bufferOverflowMs: 50,
      bufferDropMs: 80,
    });
    await track.setProcessor(processor);
    await processor.setEnabled(enabled);
    const output =
      processor.processedTrack || track.mediaStreamTrack || track.mediaStreamTrack;
    const session: NoiseFilterSession = {
      kind: "krisp",
      enabled,
      outputTrack: output,
      sourceTrack: track.mediaStreamTrack,
      ownsSource,
      setEnabled: async (next) => {
        session.enabled = next;
        await processor.setEnabled(next);
        if (next) await disableBrowserNs(track.mediaStreamTrack);
        else if (wantsBrowserNs()) {
          await enableBrowserNs(track.mediaStreamTrack);
        } else {
          await disableBrowserNs(track.mediaStreamTrack);
        }
      },
      stop: async () => {
        try {
          await track.stopProcessor();
        } catch {
          /* ignore */
        }
      },
    };
    if (enabled) await disableBrowserNs(track.mediaStreamTrack);
    return session;
  } catch {
    try {
      await track.stopProcessor();
    } catch {
      /* ignore */
    }
    return null;
  }
}

function createRnnoiseProcessor(): TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> & {
  setEnabled: (enabled: boolean) => void;
} {
  let graph: RnnoiseGraph | null = null;
  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> & {
    setEnabled: (enabled: boolean) => void;
  } = {
    name: "pulse-rnnoise",
    processedTrack: undefined,
    setEnabled: (enabled) => {
      graph?.setEnabled(enabled);
    },
    init: async (opts) => {
      graph = await startRnnoiseGraph(opts.track, true, opts.audioContext);
      processor.processedTrack = graph.outputTrack;
    },
    restart: async (opts) => {
      await graph?.stop();
      graph = await startRnnoiseGraph(opts.track, true, opts.audioContext);
      processor.processedTrack = graph.outputTrack;
    },
    destroy: async () => {
      await graph?.stop();
      graph = null;
      processor.processedTrack = undefined;
    },
  };
  return processor;
}

async function tryRnnoiseOnLiveKitTrack(
  track: LocalAudioTrack,
  enabled: boolean,
): Promise<NoiseFilterSession | null> {
  try {
    const processor = createRnnoiseProcessor();
    await track.setProcessor(processor);
    processor.setEnabled(enabled);
    const output = processor.processedTrack || track.mediaStreamTrack;
    const session: NoiseFilterSession = {
      kind: "rnnoise",
      enabled,
      outputTrack: output,
      sourceTrack: track.mediaStreamTrack,
      ownsSource: false,
      setEnabled: async (next) => {
        session.enabled = next;
        processor.setEnabled(next);
        if (next) await disableBrowserNs(track.mediaStreamTrack);
        else if (wantsBrowserNs()) {
          await enableBrowserNs(track.mediaStreamTrack);
        } else {
          await disableBrowserNs(track.mediaStreamTrack);
        }
      },
      stop: async () => {
        try {
          await track.stopProcessor();
        } catch {
          /* ignore */
        }
      },
    };
    if (enabled) await disableBrowserNs(track.mediaStreamTrack);
    return session;
  } catch {
    try {
      await track.stopProcessor();
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function applyBrowserNsPref(track: MediaStreamTrack) {
  if (wantsBrowserNs()) await enableBrowserNs(track);
  else await disableBrowserNs(track);
}

/** Attach Krisp → RNNoise → browser NS to a published LiveKit mic track. */
export async function attachNoiseFilterToLiveKitTrack(
  track: LocalAudioTrack,
  mode: NoiseFilterMode | boolean = getNoiseFilterMode(),
): Promise<NoiseFilterSession> {
  const resolved = resolveNoiseMode(mode);
  if (resolved === "high") {
    const krisp = await tryKrispOnTrack(track, true);
    if (krisp) {
      await krisp.setEnabled(true);
      return krisp;
    }
    await enableBrowserNs(track.mediaStreamTrack);
    const session = browserSession(track.mediaStreamTrack, true, false);
    warnNoiseFallback(session, true);
    return session;
  }
  await applyBrowserNsPref(track.mediaStreamTrack);
  return browserSession(track.mediaStreamTrack, wantsBrowserNs(), false);
}

/** Wrap a raw mic track (1:1 P2P, voice notes). Output track is what you send/record. */
export async function startNoiseFilter(
  sourceTrack: MediaStreamTrack,
  mode: NoiseFilterMode | boolean = getNoiseFilterMode(),
): Promise<NoiseFilterSession> {
  const resolved = resolveNoiseMode(mode);
  if (resolved === "high") {
    try {
      const { LocalAudioTrack } = await import("livekit-client");
      const lkTrack = new LocalAudioTrack(sourceTrack, undefined, true);
      const krisp = await tryKrispOnTrack(lkTrack, true, true);
      if (krisp) {
        await krisp.setEnabled(true);
        const innerStop = krisp.stop;
        krisp.stop = async () => {
          await innerStop();
          try {
            lkTrack.stop();
          } catch {
            /* ignore */
          }
        };
        return krisp;
      }
      await lkTrack.stopProcessor().catch(() => undefined);
    } catch {
      /* unsupported browser / processor failed — browser NS */
    }

    await enableBrowserNs(sourceTrack);
    const session = browserSession(sourceTrack, true, true);
    warnNoiseFallback(session, true);
    return session;
  }

  await applyBrowserNsPref(sourceTrack);
  return browserSession(sourceTrack, wantsBrowserNs(), true);
}

export async function captureFilteredMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Микрофон недоступен в этом браузере");
  }
  const capture = await navigator.mediaDevices.getUserMedia({
    audio: audioCaptureConstraints(),
    video: false,
  });
  const sourceTrack = capture.getAudioTracks()[0];
  if (!sourceTrack) {
    capture.getTracks().forEach((track) => track.stop());
    throw new Error("Нет доступа к микрофону");
  }
  try {
    const filter = await startNoiseFilter(sourceTrack);
    return {
      filter,
      stream: new MediaStream([filter.outputTrack]),
    };
  } catch (err) {
    capture.getTracks().forEach((track) => track.stop());
    throw err;
  }
}

export function noiseFilterLabel(kind: NoiseFilterKind, enabled: boolean) {
  if (!enabled || !getKrispEnabled()) return "Krisp выкл.";
  if (kind === "krisp") return "Krisp";
  if (kind === "rnnoise") return "Krisp · RNNoise";
  return "Krisp · браузер";
}
