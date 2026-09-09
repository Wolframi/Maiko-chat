import { getSoundEnabled } from "@/lib/notify";
import { applyAudioOutput } from "@/lib/mediaDevices";
import {
  CUSTOM_RINGTONE_ID,
  CUSTOM_RINGTONE_URL,
  getCustomRingtoneObjectUrl,
} from "@/lib/customRingtone";

const RINGTONE_KEY = "pulse-ringtone";

export type SavedRingtone = {
  id: string;
  title: string;
  /** App-relative proxy URL: /api/ringtones/audio?u=… */
  url: string;
  /** Start at the most dynamic section (seconds). */
  startSec?: number;
};

export type CatalogRingtone = {
  id: string;
  title: string;
  url: string;
  remoteUrl?: string;
  startSec?: number;
};

export type RingtoneCatalog = {
  ok?: boolean;
  items: CatalogRingtone[];
  page: number;
  pages: number;
  source: string;
};

/** Build same-origin proxy URL for a remote zvukogram mp3. */
export function ringtoneProxyUrl(remoteOrProxy: string) {
  if (!remoteOrProxy) return "";
  if (remoteOrProxy.startsWith("/api/ringtones/audio?")) return remoteOrProxy;
  const absolute = remoteOrProxy.startsWith("http")
    ? remoteOrProxy
    : `https://zvukogram.com${remoteOrProxy.startsWith("/") ? "" : "/"}${remoteOrProxy}`;
  return `/api/ringtones/audio?u=${encodeURIComponent(absolute)}`;
}

function playFromStart(audio: HTMLAudioElement, startSec: number) {
  const safe = Math.max(0, Number(startSec) || 0);
  if (safe <= 0.05) return;
  const seek = () => {
    try {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Math.min(safe, Math.max(0, audio.duration - 0.25));
      } else {
        audio.currentTime = safe;
      }
    } catch {
      /* ignore seek races */
    }
  };
  if (audio.readyState >= 1) seek();
  else audio.addEventListener("loadedmetadata", seek, { once: true });
}

/** Loop from dynamic start (HTML5 loop would jump back to 0). */
function attachDynamicLoop(audio: HTMLAudioElement, startSec: number) {
  const safe = Math.max(0, Number(startSec) || 0);
  if (safe <= 0.05) {
    audio.loop = true;
    return () => {
      audio.loop = false;
    };
  }
  const onEnded = () => {
    playFromStart(audio, safe);
    void audio.play().catch(() => undefined);
  };
  audio.loop = false;
  audio.addEventListener("ended", onEnded);
  return () => audio.removeEventListener("ended", onEnded);
}

function playWhenReady(audio: HTMLAudioElement) {
  const start = () => audio.play();
  if (audio.readyState >= 2) return start();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      start().then(() => finish(undefined)).catch(finish);
    }, 8000);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => {
      start().then(() => finish(undefined)).catch(finish);
    };
    const onError = () => finish(new Error("audio error"));
    audio.addEventListener("canplay", onReady, { once: true });
    audio.addEventListener("error", onError, { once: true });
    void start().then(() => finish(undefined)).catch(() => {
      /* wait for canplay / timeout */
    });
  });
}

function mapCatalogItem(raw: unknown): CatalogRingtone | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const title = typeof item.title === "string" ? item.title : "";
  const remote =
    (typeof item.audioUrl === "string" && item.audioUrl) ||
    (typeof item.remoteUrl === "string" && item.remoteUrl) ||
    "";
  const existingUrl = typeof item.url === "string" ? item.url : "";
  const url = ringtoneProxyUrl(existingUrl || remote);
  const startSec = Math.max(0, Number(item.startSec) || 0);
  if (!id || !title || !url) return null;
  return {
    id,
    title: title.slice(0, 120),
    url,
    remoteUrl: remote || undefined,
    startSec,
  };
}

function normalizeStored(raw: unknown): SavedRingtone | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Record<string, unknown>;
  const id = typeof parsed.id === "string" ? parsed.id : "";
  const title = typeof parsed.title === "string" ? parsed.title : "";
  // Prefer `url`; accept legacy `audioUrl` and wrap via proxy helper.
  let url = typeof parsed.url === "string" ? parsed.url : "";
  const audioUrl =
    typeof parsed.audioUrl === "string" ? parsed.audioUrl : "";
  if (!url && audioUrl) url = ringtoneProxyUrl(audioUrl);
  if (!id || id === "default" || !title || !url) return null;
  if (id === CUSTOM_RINGTONE_ID || url === CUSTOM_RINGTONE_URL || url.startsWith("idb:")) {
    return {
      id: CUSTOM_RINGTONE_ID,
      title: title.slice(0, 120) || "Свой рингтон",
      url: CUSTOM_RINGTONE_URL,
      startSec: 0,
    };
  }
  if (!url.startsWith("/api/ringtones/audio?")) return null;
  const startSec = Math.max(0, Number(parsed.startSec) || 0);
  return { id, title: title.slice(0, 120), url, startSec };
}

export function getSavedRingtone(): SavedRingtone | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(RINGTONE_KEY);
    if (!raw) return null;
    return normalizeStored(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function setSavedRingtone(value: SavedRingtone | null) {
  if (typeof window === "undefined") return;
  try {
    if (!value) localStorage.removeItem(RINGTONE_KEY);
    else {
      localStorage.setItem(
        RINGTONE_KEY,
        JSON.stringify({
          id: value.id,
          title: value.title.slice(0, 120),
          url: value.url,
          startSec: Math.max(0, Number(value.startSec) || 0),
        }),
      );
    }
    window.dispatchEvent(
      new CustomEvent("pulse:ringtone-changed", { detail: value }),
    );
    if (value?.url) prefetchRingtone(value.url);
  } catch {
    /* ignore */
  }
}

export async function fetchRingtoneCatalog(page = 1): Promise<RingtoneCatalog> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/api/ringtones?page=${page}`, {
        credentials: "same-origin",
      });
      const body = (await res.json().catch(() => null)) as
        | (RingtoneCatalog & { error?: string })
        | null;
      if (!res.ok || !body || body.ok === false) {
        throw new Error(body?.error || "Не удалось загрузить каталог");
      }
      return {
        items: (Array.isArray(body.items) ? body.items : [])
          .map(mapCatalogItem)
          .filter((item): item is CatalogRingtone => Boolean(item)),
        page: Number(body.page) || page,
        pages: Number(body.pages) || 1,
        source: body.source || "zvukogram.com",
      };
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("Не удалось загрузить каталог");
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError || new Error("Не удалось загрузить каталог");
}

export function prefetchRingtone(url: string | null | undefined) {
  if (!url || typeof window === "undefined") return;
  if (url === CUSTOM_RINGTONE_URL || url.startsWith("idb:")) {
    void getCustomRingtoneObjectUrl();
    return;
  }
  void fetch(url, { credentials: "same-origin", cache: "force-cache" }).catch(
    () => undefined,
  );
}

export async function getRingtonePlayUrl(saved: SavedRingtone | null) {
  if (!saved) return null;
  return resolvePlayUrl(saved);
}

async function resolvePlayUrl(saved: SavedRingtone): Promise<string | null> {
  if (saved.id === CUSTOM_RINGTONE_ID || saved.url === CUSTOM_RINGTONE_URL) {
    return getCustomRingtoneObjectUrl();
  }
  return saved.url;
}

/** One-shot preview (not looping). Pass null for the built-in beep. */
export function previewRingtone(
  url: string | null,
  onError?: (message: string) => void,
) {
  if (typeof window === "undefined") return () => undefined;
  if (!url) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return () => undefined;
    const ctx = new Ctx();
    void ctx.resume().then(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.04;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
      window.setTimeout(() => void ctx.close(), 400);
    });
    return () => {
      void ctx.close();
    };
  }

  const audio = new Audio(url);
  audio.preload = "auto";
  audio.volume = 0.85;
  const fail = () => onError?.("Не удалось воспроизвести");
  audio.addEventListener("error", fail, { once: true });
  void playWhenReady(audio)
    .then(() => applyAudioOutput(audio))
    .catch(fail);
  return () => {
    audio.removeEventListener("error", fail);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
}

export function previewRingtoneFrom(
  url: string | null,
  startSec = 0,
  onError?: (message: string) => void,
) {
  if (!url) return previewRingtone(null, onError);
  if (typeof window === "undefined") return () => undefined;
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.volume = 0.85;
  void applyAudioOutput(audio);
  const fail = () => onError?.("Не удалось воспроизвести");
  audio.addEventListener("error", fail, { once: true });
  playFromStart(audio, startSec);
  void playWhenReady(audio)
    .then(() => applyAudioOutput(audio))
    .catch(fail);
  return () => {
    audio.removeEventListener("error", fail);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
}

function startBeepLoop() {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return () => undefined;

  const ctx = new Ctx();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function beep() {
    if (stopped) return;
    if (!getSoundEnabled()) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.03;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    timer = setTimeout(beep, 1400);
  }

  void ctx.resume().then(beep);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    void ctx.close();
  };
}

/**
 * Looping incoming-call ringtone. Falls back to short beep pulse when no custom tone.
 */
export function startIncomingRingtone() {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  if (!getSoundEnabled()) return () => undefined;

  const saved = getSavedRingtone();
  if (saved?.url) {
    let stopped = false;
    let fallbackStop: (() => void) | null = null;
    let detachLoop = () => {};
    let audio: HTMLAudioElement | null = null;
    const fallback = () => {
      if (stopped || fallbackStop) return;
      detachLoop();
      fallbackStop = startBeepLoop();
    };
    void resolvePlayUrl(saved).then((url) => {
      if (stopped) return;
      if (!url) {
        fallback();
        return;
      }
      audio = new Audio(url);
      audio.preload = "auto";
      audio.volume = 0.9;
      detachLoop = attachDynamicLoop(audio, saved.startSec || 0);
      playFromStart(audio, saved.startSec || 0);
      audio.addEventListener("error", fallback, { once: true });
      void playWhenReady(audio)
        .then(() => applyAudioOutput(audio))
        .catch(fallback);
    }).catch(fallback);
    return () => {
      stopped = true;
      detachLoop();
      if (audio) {
        audio.pause();
        audio.src = "";
      }
      fallbackStop?.();
    };
  }

  return startBeepLoop();
}

/**
 * Quiet Discord-like ringback for the caller while waiting for accept.
 * Not the incoming ringtone — a two-tone pulse so it is obvious you are calling.
 */
export function startOutgoingRingtone() {
  if (typeof window === "undefined") return () => undefined;
  if (!getSoundEnabled()) return () => undefined;

  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return () => undefined;

  const ctx = new Ctx();
  let stopped = false;
  let timer = 0;

  function chirp(at: number) {
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    const gain = ctx.createGain();
    oscA.type = "sine";
    oscB.type = "sine";
    oscA.frequency.value = 440;
    oscB.frequency.value = 480;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.05, at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
    oscA.connect(gain);
    oscB.connect(gain);
    gain.connect(ctx.destination);
    oscA.start(at);
    oscB.start(at);
    oscA.stop(at + 0.44);
    oscB.stop(at + 0.44);
  }

  function cycle() {
    if (stopped) return;
    const t = ctx.currentTime;
    chirp(t);
    chirp(t + 0.5);
    timer = window.setTimeout(cycle, 2200);
  }

  void ctx.resume().then(cycle);

  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    void ctx.close();
  };
}
