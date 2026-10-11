"use client";

import type { LocalAudioTrack, AudioProcessorOptions, TrackProcessor } from "livekit-client";
import { Track } from "livekit-client";
import { createDtlnGraph, type DtlnGraph } from "@/lib/dtlnGraph";
import { toast } from "sonner";
import { emitVoiceSettings, getMicDeviceId } from "@/lib/mediaDevices";

export type NoiseFilterKind = "dtln" | "browser";

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
// Keep the existing preference key when migrating from Krisp to DTLN.
const NEURAL_KEY = "pulse-krisp";
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
  if (readStorage(NEURAL_KEY) !== null || readStorage(BROWSER_NS_KEY) !== null) {
    return;
  }
  const legacy = readStorage(PREF_KEY);
  if (legacy === null) return;
  const mode = parseNoiseMode(legacy);
  if (mode === "high") {
    writeStorage(NEURAL_KEY, "1");
    writeStorage(BROWSER_NS_KEY, "70");
  } else if (mode === "standard") {
    writeStorage(NEURAL_KEY, "0");
    writeStorage(BROWSER_NS_KEY, "70");
  } else {
    writeStorage(NEURAL_KEY, "0");
    writeStorage(BROWSER_NS_KEY, "0");
  }
}

export function getNeuralNoiseEnabled() {
  migrateVoicePrefs();
  const value = readStorage(NEURAL_KEY);
  if (value === null) return true;
  return value === "1";
}

export function setNeuralNoiseEnabled(enabled: boolean, emit = true) {
  migrateVoicePrefs();
  if (enabled === getNeuralNoiseEnabled()) return;
  writeStorage(NEURAL_KEY, enabled ? "1" : "0");
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
  return !getNeuralNoiseEnabled() && getBrowserNsStrength() > 0;
}

export function getNoiseFilterMode(): NoiseFilterMode {
  if (getNeuralNoiseEnabled()) return "high";
  if (getBrowserNsStrength() > 0) return "standard";
  return "off";
}

export function getLastNoiseFilterMode(): NoiseFilterMode {
  return getNeuralNoiseEnabled() ? "high" : "standard";
}

export function setNoiseFilterMode(mode: NoiseFilterMode, emit = true) {
  if (mode === "high") {
    writeStorage(NEURAL_KEY, "1");
    if (readStorage(BROWSER_NS_KEY) === null) writeStorage(BROWSER_NS_KEY, "70");
  } else if (mode === "standard") {
    writeStorage(NEURAL_KEY, "0");
    if (getBrowserNsStrength() === 0) writeStorage(BROWSER_NS_KEY, "70");
  } else {
    writeStorage(NEURAL_KEY, "0");
    writeStorage(BROWSER_NS_KEY, "0");
  }
  if (emit) emitVoiceSettings({ noise: true });
}

/** Overlay sparkles: DTLN on/off, independent from the built-in slider. */
export function getNoiseFilterPref(): boolean {
  return getNeuralNoiseEnabled();
}

export function setNoiseFilterPref(enabled: boolean) {
  setNeuralNoiseEnabled(enabled);
}

function resolveNoiseMode(mode?: NoiseFilterMode | boolean): NoiseFilterMode {
  if (mode === true) return "high";
  if (mode === false) return "off";
  if (mode) return mode;
  return getNoiseFilterMode();
}

/** Keep browser NS before DTLN, including model startup and late-frame bypass. */
export function audioCaptureConstraints(): MediaTrackConstraints {
  const micId = getMicDeviceId();
  return {
    echoCancellation: true,
    noiseSuppression: getNoiseFilterMode() !== "off",
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

async function setBrowserNs(track: MediaStreamTrack, enabled: boolean) {
  if (track.readyState === "ended") return;
  const constraints = track.getConstraints();
  // Chromium may keep reporting the initial getSettings value after a toggle.
  // Compare the requested constraints so off -> on cannot silently stay off.
  if (constraints.noiseSuppression === enabled) return;
  try {
    // applyConstraints replaces the constraint set: preserve the selected mic and AEC/AGC.
    await track.applyConstraints({ ...constraints, noiseSuppression: enabled });
  } catch {
    /* Devices can reject changes during capture; keep the existing audio. */
  }
}

/** Stable output for the whole capture; toggles never reopen the microphone. */
export async function startNoiseFilter(
  sourceTrack: MediaStreamTrack,
  mode: NoiseFilterMode | boolean = getNoiseFilterMode(),
): Promise<NoiseFilterSession> {
  const resolved = resolveNoiseMode(mode);
  let graph: DtlnGraph | undefined;
  let stopped = false;
  let failed = false;
  let updates = Promise.resolve();
  const session: NoiseFilterSession = {
    kind: "browser",
    enabled: resolved !== "off",
    sourceTrack,
    outputTrack: sourceTrack,
    ownsSource: true,
    setEnabled(next) {
      updates = updates.catch(() => undefined).then(async () => {
        if (stopped) return;
        session.enabled = next || wantsBrowserNs();
        await setBrowserNs(sourceTrack, session.enabled);
        if (stopped) return;
        const available = graph && await graph.setEnabled(next);
        if (stopped) return;
        session.kind = available && !failed ? "dtln" : "browser";
        warnNoiseFallback(session, next);
      });
      return updates;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await graph?.stop();
    },
  };
  await setBrowserNs(sourceTrack, resolved !== "off");
  try {
    graph = await createDtlnGraph(sourceTrack, () => {
      failed = true;
      session.kind = "browser";
      if (!stopped) {
        void setBrowserNs(sourceTrack, session.enabled);
        warnNoiseFallback(session, session.enabled);
        emitVoiceSettings({ noise: true });
      }
    });
    session.outputTrack = graph.outputTrack;
    const available = await graph.setEnabled(resolved === "high");
    session.kind = available && !failed ? "dtln" : "browser";
  } catch {
    failed = true;
    await graph?.stop();
    graph = undefined;
    session.outputTrack = sourceTrack;
  }
  warnNoiseFallback(session, resolved === "high");
  return session;
}

/** LiveKit owns capture; the processor owns only its graph and output track. */
export async function attachNoiseFilterToLiveKitTrack(
  track: LocalAudioTrack,
  mode: NoiseFilterMode | boolean = getNoiseFilterMode(),
): Promise<NoiseFilterSession> {
  let current: NoiseFilterSession | undefined;
  let desired = resolveNoiseMode(mode);
  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: "pulse-dtln",
    async init(opts) {
      current = await startNoiseFilter(opts.track, desired);
      current.ownsSource = false;
      // LiveKit stops processedTrack on teardown; never give it the raw capture.
      processor.processedTrack = current.outputTrack === opts.track ? undefined : current.outputTrack;
    },
    async restart(opts) {
      // Device changes supply a new raw source. Never keep the old processed track.
      await current?.stop();
      await processor.init(opts);
    },
    async destroy() {
      await current?.stop();
      processor.processedTrack = undefined;
    },
  };
  try {
    await track.setProcessor(processor);
  } catch {
    if (track.getProcessor() === processor) await track.stopProcessor().catch(() => undefined);
    else await processor.destroy();
    // A failed processor must not leave a silent microphone in the room.
    await setBrowserNs(track.mediaStreamTrack, desired !== "off");
    current = {
      kind: "browser", enabled: desired !== "off", ownsSource: false,
      sourceTrack: track.mediaStreamTrack, outputTrack: track.mediaStreamTrack,
      async setEnabled(next) {
        if (!current) return;
        current.enabled = next || wantsBrowserNs();
        await setBrowserNs(current.sourceTrack, current.enabled);
      },
      async stop() {},
    };
    warnNoiseFallback(current, desired === "high");
  }
  return {
    get kind() { return current!.kind; },
    get enabled() { return current!.enabled; },
    get sourceTrack() { return current!.sourceTrack; },
    get outputTrack() { return current!.outputTrack; },
    ownsSource: false,
    async setEnabled(next) {
      desired = next ? "high" : wantsBrowserNs() ? "standard" : "off";
      await current?.setEnabled(next);
    },
    async stop() {
      // Do not tear down a newer processor installed by another capture.
      if (track.getProcessor() === processor) await track.stopProcessor();
      else await current?.stop();
    },
  };
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
    return { filter, stream: new MediaStream([filter.outputTrack]) };
  } catch (err) {
    capture.getTracks().forEach((track) => track.stop());
    throw err;
  }
}

export function noiseFilterLabel(kind: NoiseFilterKind, enabled: boolean) {
  if (!enabled || !getNeuralNoiseEnabled()) return "DTLN выкл.";
  return kind === "dtln" ? "DTLN" : "Шумоподавление · браузер";
}
