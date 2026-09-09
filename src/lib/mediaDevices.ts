"use client";

const MIC_KEY = "pulse-mic-device";
const SPEAKER_KEY = "pulse-speaker-device";
export const VOICE_SETTINGS_EVENT = "pulse-voice-settings";

export type VoiceSettingsChange = {
  mic?: boolean;
  speaker?: boolean;
  noise?: boolean;
};

export type AudioDeviceOption = {
  deviceId: string;
  label: string;
  kind: "audioinput" | "audiooutput";
};

type Sinkable = HTMLMediaElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type SinkableContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

function readPref(key: string) {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writePref(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function emitVoiceSettings(change: VoiceSettingsChange) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<VoiceSettingsChange>(VOICE_SETTINGS_EVENT, {
      detail: change,
    }),
  );
}

export function subscribeVoiceSettings(
  handler: (change: VoiceSettingsChange) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  function onEvent(event: Event) {
    const detail =
      (event as CustomEvent<VoiceSettingsChange>).detail || {};
    handler(detail);
  }
  window.addEventListener(VOICE_SETTINGS_EVENT, onEvent);
  return () => window.removeEventListener(VOICE_SETTINGS_EVENT, onEvent);
}

export function getMicDeviceId() {
  return readPref(MIC_KEY);
}

export function getSpeakerDeviceId() {
  return readPref(SPEAKER_KEY);
}

export function setMicDeviceId(deviceId: string) {
  const next = deviceId === "default" ? "" : deviceId;
  if (next === getMicDeviceId()) return;
  writePref(MIC_KEY, next);
  emitVoiceSettings({ mic: true });
}

export function setSpeakerDeviceId(deviceId: string) {
  const next = deviceId === "default" ? "" : deviceId;
  if (next === getSpeakerDeviceId()) return;
  writePref(SPEAKER_KEY, next);
  emitVoiceSettings({ speaker: true });
}

export function canSelectAudioOutput() {
  if (typeof HTMLMediaElement === "undefined") return false;
  return (
    typeof (HTMLMediaElement.prototype as Sinkable).setSinkId === "function"
  );
}

export async function applyAudioOutput(
  el: HTMLMediaElement | null | undefined,
) {
  if (!el) return;
  const sink = (el as Sinkable).setSinkId;
  if (typeof sink !== "function") return;
  const id = getSpeakerDeviceId();
  try {
    await sink.call(el, id || "default");
  } catch {
    try {
      await sink.call(el, "");
    } catch {
      /* Safari / locked output */
    }
  }
}

function labelFor(device: MediaDeviceInfo, index: number) {
  if (device.label) return device.label;
  if (device.kind === "audiooutput") return `Колонки ${index + 1}`;
  return `Микрофон ${index + 1}`;
}

export async function ensureMicPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Микрофон недоступен в этом браузере");
  }
  const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
  tmp.getTracks().forEach((track) => track.stop());
}

export async function listAudioDevices(): Promise<{
  mics: AudioDeviceOption[];
  speakers: AudioDeviceOption[];
}> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { mics: [], speakers: [] };
  }
  let devices = await navigator.mediaDevices.enumerateDevices();
  const needsLabels = devices.some(
    (device) =>
      (device.kind === "audioinput" || device.kind === "audiooutput") &&
      !device.label,
  );
  if (needsLabels) {
    try {
      await ensureMicPermission();
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      /* labels stay empty until the user grants mic access */
    }
  }

  const mics: AudioDeviceOption[] = [];
  const speakers: AudioDeviceOption[] = [];
  let micIndex = 0;
  let speakerIndex = 0;
  for (const device of devices) {
    if (device.deviceId === "default" || device.deviceId === "communications") {
      continue;
    }
    if (device.kind === "audioinput") {
      mics.push({
        deviceId: device.deviceId,
        label: labelFor(device, micIndex),
        kind: "audioinput",
      });
      micIndex += 1;
    } else if (device.kind === "audiooutput") {
      speakers.push({
        deviceId: device.deviceId,
        label: labelFor(device, speakerIndex),
        kind: "audiooutput",
      });
      speakerIndex += 1;
    }
  }
  return { mics, speakers };
}

export async function playSpeakerTest(deviceId = getSpeakerDeviceId()) {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  try {
    const sink = (ctx as SinkableContext).setSinkId;
    if (typeof sink === "function") {
      await sink.call(ctx, deviceId || "default").catch(() => undefined);
    }
    if (ctx.state === "suspended") await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.35);
    gain.gain.value = 0.045;
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
