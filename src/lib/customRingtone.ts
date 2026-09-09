export const CUSTOM_RINGTONE_ID = "custom";
export const CUSTOM_RINGTONE_URL = "idb:custom";
export const CUSTOM_MAX_SEC = 45;
export const CUSTOM_MAX_BYTES = 12 * 1024 * 1024;
export const RINGTONE_FADE_IN_SEC = 0.09;
export const RINGTONE_FADE_OUT_SEC = 0.4;

const DB_NAME = "pulse-ringtone";
const STORE = "clips";
const TRIMMED_KEY = "custom";
const SOURCE_KEY = "custom-source";

type SourceRecord = {
  blob: Blob;
  name: string;
  startSec: number;
  endSec: number;
};

let objectUrl: string | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB"));
  });
}

function idbGet<T>(key: string): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbDelete(keys: string[]): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const key of keys) store.delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export function validateRingtoneFile(file: File): string | null {
  if (!file || file.size <= 0) return "Выберите аудиофайл";
  if (file.size > CUSTOM_MAX_BYTES) return "Файл больше 12 МБ";
  const name = file.name.toLowerCase();
  const mime = (file.type || "").toLowerCase();
  const okMime = mime.startsWith("audio/");
  const okName = /\.(mp3|wav|m4a|aac|ogg|opus|flac|weba|webm)$/i.test(name);
  if (!okMime && !okName) return "Нужен аудиофайл (mp3, wav, m4a, ogg)";
  return null;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const rate = buffer.sampleRate;
  const length = buffer.length;
  const dataSize = length * channels * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  const chans = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

/** Raised-cosine (Hann) fades — same curve as ffmpeg afade curve=hsin. */
function applyHannFades(
  buffer: AudioBuffer,
  fadeInSec = RINGTONE_FADE_IN_SEC,
  fadeOutSec = RINGTONE_FADE_OUT_SEC,
) {
  const dur = buffer.duration;
  if (dur < 0.2 || buffer.length < 32) return;
  const nIn = Math.max(
    1,
    Math.floor(Math.min(fadeInSec, dur * 0.12) * buffer.sampleRate),
  );
  const nOut = Math.max(
    1,
    Math.floor(Math.min(fadeOutSec, dur * 0.22) * buffer.sampleRate),
  );
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const len = data.length;
    for (let i = 0; i < nIn && i < len; i++) {
      data[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / nIn);
    }
    for (let i = 0; i < nOut && i < len; i++) {
      data[len - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / nOut);
    }
  }
}

export async function trimAudioFile(
  file: Blob,
  startSec: number,
  endSec: number,
): Promise<Blob> {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) throw new Error("Браузер не умеет обрезать аудио");
  const ctx = new Ctx();
  try {
    const raw = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    const rate = decoded.sampleRate;
    const from = Math.max(0, Math.floor(startSec * rate));
    const to = Math.min(decoded.length, Math.floor(endSec * rate));
    const frames = Math.max(1, to - from);
    const cut = ctx.createBuffer(decoded.numberOfChannels, frames, rate);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      cut.copyToChannel(decoded.getChannelData(c).subarray(from, to), c);
    }
    applyHannFades(cut);
    return encodeWav(cut);
  } finally {
    void ctx.close();
  }
}

export function titleFromFileName(name: string) {
  const base = name.replace(/\.[^.]+$/, "").trim();
  return (base || "Свой рингтон").slice(0, 80);
}

export async function saveCustomRingtone(opts: {
  trimmed: Blob;
  source: Blob;
  sourceName: string;
  startSec: number;
  endSec: number;
  title: string;
}) {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  await idbPut(TRIMMED_KEY, opts.trimmed);
  const source: SourceRecord = {
    blob: opts.source,
    name: opts.sourceName,
    startSec: opts.startSec,
    endSec: opts.endSec,
  };
  await idbPut(SOURCE_KEY, source);
  objectUrl = URL.createObjectURL(opts.trimmed);
  return objectUrl;
}

export async function getCustomRingtoneObjectUrl(): Promise<string | null> {
  if (objectUrl) return objectUrl;
  const blob = await idbGet<Blob>(TRIMMED_KEY);
  if (!blob) return null;
  objectUrl = URL.createObjectURL(blob);
  return objectUrl;
}

export async function loadCustomSource(): Promise<{
  file: File;
  startSec: number;
  endSec: number;
} | null> {
  const rec = await idbGet<SourceRecord>(SOURCE_KEY);
  if (!rec?.blob) return null;
  const file = new File([rec.blob], rec.name || "ringtone.mp3", {
    type: rec.blob.type || "audio/mpeg",
  });
  return {
    file,
    startSec: Number(rec.startSec) || 0,
    endSec: Number(rec.endSec) || 0,
  };
}

export async function hasCustomRingtone() {
  const blob = await idbGet<Blob>(TRIMMED_KEY);
  return Boolean(blob && blob.size > 0);
}

export async function clearCustomRingtone() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  await idbDelete([TRIMMED_KEY, SOURCE_KEY]);
}
