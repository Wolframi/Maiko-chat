"use client";

import type { ChatMessage } from "@/lib/types";
import {
  audioDisplayName,
  bareMediaUrl,
  isAudioAttachment,
  isVoiceNote,
  messageAttachments,
  signedMediaSrc,
  mediaSrc,
} from "@/lib/files";

export const PLAYBACK_RATES = [1, 1.5, 2, 0.5] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export type AudioKind = "voice" | "audio";

export type AudioTrack = {
  id: string;
  messageId: string;
  roomId: string;
  src: string;
  kind: AudioKind;
  title: string;
  author: string;
  createdAt: number;
};

export type AudioPlaybackState = {
  current: AudioTrack | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  volume: number;
  visible: boolean;
};

const RATE_KEY = "pulse-audio-rate";
const VOLUME_KEY = "pulse-audio-volume";

const listeners = new Set<() => void>();
const roomTracks = new Map<string, AudioTrack[]>();
const failedSrcs = new Set<string>();
const warmedSrcs = new Set<string>();
const prefetching = new Set<string>();
const prefetchQueue: string[] = [];
const warmers = new Map<string, HTMLAudioElement>();
const MAX_PREFETCH = 1;

let audioEl: HTMLAudioElement | null = null;
let pendingSeek: number | null = null;
let lastTimeEmit = 0;
let bound = false;
let closing = false;
let lastAudibleVolume = 1;
let durationSource: "none" | "media" | "decoded" = "none";
let clockWall = 0;
let clockMedia = 0;
let clockRate = 1;

function readStoredRate(): number {
  if (typeof window === "undefined") return 1;
  try {
    const raw = Number(localStorage.getItem(RATE_KEY));
    return PLAYBACK_RATES.includes(raw as PlaybackRate) ? raw : 1;
  } catch {
    return 1;
  }
}

function readStoredVolume(): number {
  if (typeof window === "undefined") return 1;
  try {
    const raw = Number(localStorage.getItem(VOLUME_KEY));
    if (!Number.isFinite(raw)) return 1;
    return Math.min(1, Math.max(0, raw));
  } catch {
    return 1;
  }
}

let state: AudioPlaybackState = {
  current: null,
  playing: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  volume: 1,
  visible: false,
};

function emit() {
  listeners.forEach((listener) => listener());
}

function patch(partial: Partial<AudioPlaybackState>) {
  state = { ...state, ...partial };
  emit();
}

function persistPrefs() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(RATE_KEY, String(state.playbackRate));
    localStorage.setItem(VOLUME_KEY, String(state.volume));
  } catch {
    /* ignore */
  }
}

export function audioTrackId(messageId: string, url: string) {
  return `${messageId}:${bareMediaUrl(url)}`;
}

export function collectRoomAudioTracks(messages: ChatMessage[]): AudioTrack[] {
  const tracks: AudioTrack[] = [];
  for (const message of messages) {
    if (message.kind === "system" || message.kind === "call") continue;
    for (const file of messageAttachments(message)) {
      if (!isAudioAttachment(file) || !file.url) continue;
      const src = signedMediaSrc(file.url) || mediaSrc(file.url);
      if (!src) continue;
      tracks.push({
        id: audioTrackId(message.clientKey || message.id, file.url),
        messageId: message.id,
        roomId: message.room,
        src,
        kind: isVoiceNote(file) ? "voice" : "audio",
        title: audioDisplayName(file),
        author: message.author,
        createdAt: message.createdAt,
      });
    }
  }
  return tracks;
}

export function resolvePlayableSrc(src: string) {
  return src;
}

function readMediaDuration(audio: HTMLAudioElement) {
  const reported = audio.duration;
  if (Number.isFinite(reported) && reported > 0) return reported;
  try {
    if (audio.seekable.length > 0) {
      const end = audio.seekable.end(audio.seekable.length - 1);
      if (Number.isFinite(end) && end > 0) return end;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function adoptDuration(next: number, source: "media" | "decoded" = "media") {
  if (!Number.isFinite(next) || next <= 0) return;
  const prev = state.duration;
  const time = audioEl && !closing ? audioEl.currentTime : state.currentTime;
  if (!prev) {
    durationSource = source;
    patch({ duration: next });
    return;
  }
  if (source === "decoded") {
    if (time > next + 0.35) return;
    if (durationSource === "decoded") {
      if (Math.abs(next - prev) < 0.05) return;
      if (next > prev + 0.15) return;
    }
    durationSource = "decoded";
    patch({ duration: next });
    return;
  }
  if (durationSource === "decoded") return;
  if (time > 0.35) return;
  if (Math.abs(next - prev) / prev > 0.04) return;
  if (Math.abs(next - prev) < 0.02) return;
  patch({ duration: next });
}

export function lockPlaybackDuration(seconds: number) {
  adoptDuration(seconds, "decoded");
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function resetPlaybackClock(time?: number) {
  clockWall = nowMs();
  clockMedia = time ?? (audioEl && !closing ? audioEl.currentTime : state.currentTime);
  clockRate = audioEl?.playbackRate || state.playbackRate || 1;
}

export function getLivePlaybackTime() {
  const audio = audioEl;
  if (audio && state.current && !closing && audio.src) {
    return {
      currentTime: audio.currentTime,
      duration: state.duration,
      playing: !audio.paused && !audio.ended,
      rate: audio.playbackRate || 1,
    };
  }
  return {
    currentTime: state.currentTime,
    duration: state.duration,
    playing: state.playing,
    rate: state.playbackRate || 1,
  };
}

export function getSmoothPlaybackTime() {
  const live = getLivePlaybackTime();
  const duration = state.duration;
  const rate = live.rate || 1;
  const wall = nowMs();

  if (!live.playing) {
    clockMedia = live.currentTime;
    clockWall = wall;
    clockRate = rate;
    return { currentTime: live.currentTime, duration, playing: false, rate };
  }

  if (!clockWall || Math.abs(clockRate - rate) > 0.001) {
    clockMedia = live.currentTime;
    clockWall = wall;
    clockRate = rate;
  }

  let time = clockMedia + ((wall - clockWall) / 1000) * clockRate;
  if (duration > 0 && time > duration) time = duration;
  if (time < 0) time = 0;
  return { currentTime: time, duration, playing: true, rate };
}

function releaseWarmer(src: string) {
  const el = warmers.get(src);
  if (!el) return;
  warmers.delete(src);
  try {
    el.removeAttribute("src");
    el.load();
  } catch {
    /* ignore */
  }
}

function finishPrefetch(src: string) {
  if (!prefetching.has(src)) return;
  prefetching.delete(src);
  warmedSrcs.add(src);
  window.setTimeout(() => releaseWarmer(src), 400);
  const next = prefetchQueue.shift();
  if (next) prefetchAudioSrc(next);
}

export function prefetchAudioSrc(src: string) {
  if (typeof window === "undefined" || !src || failedSrcs.has(src)) return;
  if (warmedSrcs.has(src) || prefetching.has(src) || warmers.has(src)) return;
  if (state.current && sameTrackSrc(state.current.src, src) && audioEl?.src) {
    warmedSrcs.add(src);
    return;
  }
  if (prefetching.size >= MAX_PREFETCH) {
    if (!prefetchQueue.includes(src)) prefetchQueue.push(src);
    return;
  }
  prefetching.add(src);
  const el = new Audio();
  el.preload = "auto";
  el.muted = true;
  el.src = src;
  warmers.set(src, el);
  const done = () => finishPrefetch(src);
  el.addEventListener("canplaythrough", done, { once: true });
  el.addEventListener("error", done, { once: true });
  window.setTimeout(done, 5000);
}

function sameTrackSrc(a: string, b: string) {
  return a === b || bareMediaUrl(a) === bareMediaUrl(b);
}

export function setRoomAudioTracks(roomId: string, tracks: AudioTrack[]) {
  if (!roomId) return;
  roomTracks.set(roomId, tracks);
  if (state.current?.roomId === roomId) emit();
  if (state.playing) return;
  const last = tracks[tracks.length - 1];
  if (last) prefetchAudioSrc(last.src);
}

function sameTrack(a: AudioTrack, b: AudioTrack) {
  return a.id === b.id || (a.roomId === b.roomId && a.src === b.src);
}

function playlistFor(track: AudioTrack) {
  return (roomTracks.get(track.roomId) || []).filter((item) => item.kind === track.kind);
}

function indexInPlaylist(track: AudioTrack) {
  const list = playlistFor(track);
  return list.findIndex((item) => sameTrack(item, track));
}

export function peekAdjacentTrack(direction: 1 | -1, from = state.current) {
  if (!from) return null;
  const list = playlistFor(from);
  const index = indexInPlaylist(from);
  if (index < 0) return direction === 1 ? list[0] || null : null;
  return list[index + direction] || null;
}

function applyPendingSeek(audio: HTMLAudioElement) {
  if (pendingSeek == null) return;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const time = duration > 0 ? Math.min(Math.max(pendingSeek, 0), duration) : Math.max(pendingSeek, 0);
  try {
    audio.currentTime = time;
  } catch {
    /* not seekable yet */
    return;
  }
  pendingSeek = null;
  adoptDuration(readMediaDuration(audio));
  patch({ currentTime: time });
  resetPlaybackClock(time);
}

function bindAudio(audio: HTMLAudioElement) {
  if (bound) return;
  bound = true;
  audio.preload = "auto";
  audio.preservesPitch = true;
  audio.addEventListener("loadedmetadata", () => {
    if (closing) return;
    applyPendingSeek(audio);
    adoptDuration(readMediaDuration(audio));
  });
  audio.addEventListener("durationchange", () => {
    if (closing) return;
    adoptDuration(readMediaDuration(audio));
  });
  audio.addEventListener("timeupdate", () => {
    if (closing) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const minGap = audio.playbackRate > 1.2 ? 220 : 160;
    if (now - lastTimeEmit < minGap && !audio.paused) return;
    lastTimeEmit = now;
    adoptDuration(readMediaDuration(audio));
    patch({
      currentTime: audio.currentTime,
      duration: state.duration || readMediaDuration(audio),
    });
  });
  audio.addEventListener("play", () => {
    if (closing) return;
    resetPlaybackClock();
    patch({ playing: true, visible: true });
  });
  audio.addEventListener("pause", () => {
    if (closing || audio.ended) return;
    patch({ playing: false, currentTime: audio.currentTime });
  });
  audio.addEventListener("ended", () => {
    if (closing) return;
    const next = peekAdjacentTrack(1);
    if (next) {
      void playAudioTrack(next);
      return;
    }
    patch({ playing: false, currentTime: 0 });
    try {
      audio.currentTime = 0;
    } catch {
      /* ignore */
    }
  });
  audio.addEventListener("error", () => {
    if (closing) return;
    const current = state.current;
    if (current?.src) failedSrcs.add(current.src);
    const next = peekAdjacentTrack(1);
    if (next && next.src !== current?.src && !failedSrcs.has(next.src)) {
      void playAudioTrack(next);
      return;
    }
    patch({ playing: false });
  });
}

function getAudio() {
  if (typeof window === "undefined") return null;
  if (!audioEl) {
    audioEl = new Audio();
    bindAudio(audioEl);
    audioEl.playbackRate = state.playbackRate;
    audioEl.volume = state.volume;
  }
  return audioEl;
}

function hydratePrefs() {
  if (typeof window === "undefined") return;
  const playbackRate = readStoredRate();
  const volume = readStoredVolume();
  if (playbackRate !== state.playbackRate || volume !== state.volume) {
    state = { ...state, playbackRate, volume };
  }
  const audio = getAudio();
  if (audio) {
    audio.playbackRate = playbackRate;
    audio.volume = volume;
  }
}

if (typeof window !== "undefined") hydratePrefs();

export function subscribeAudioPlayback(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAudioPlaybackState() {
  return state;
}

export function getAudioPlaybackServerState(): AudioPlaybackState {
  return {
    current: null,
    playing: false,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    volume: 1,
    visible: false,
  };
}

function probeExactDuration(src: string) {
  if (typeof window === "undefined" || !src) return;
  const probe = new Audio();
  probe.preload = "auto";
  let settled = false;
  const finish = (seconds: number) => {
    if (settled) return;
    settled = true;
    try {
      probe.removeAttribute("src");
      probe.load();
    } catch {
      /* ignore */
    }
    if (seconds > 0.05 && seconds < 7200 && state.current?.src === src) {
      adoptDuration(seconds, "decoded");
    }
  };
  probe.addEventListener("loadedmetadata", () => {
    try {
      probe.currentTime = 1e10;
    } catch {
      finish(readMediaDuration(probe));
    }
  });
  probe.addEventListener("seeked", () => finish(probe.currentTime));
  probe.addEventListener("error", () => finish(0));
  window.setTimeout(() => finish(readMediaDuration(probe)), 6000);
  probe.src = src;
}

export async function playAudioTrack(track: AudioTrack, opts?: { time?: number }) {
  closing = false;
  const audio = getAudio();
  if (!audio) return;

  const same =
    state.current &&
    sameTrack(state.current, track) &&
    audio.src &&
    !audio.error;

  if (opts?.time != null) pendingSeek = opts.time;

  if (same) {
    applyPendingSeek(audio);
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        patch({ playing: false });
      }
    }
    return;
  }

  const list = playlistFor(track);
  const fresh = list.find((item) => sameTrack(item, track)) || track;

  durationSource = "none";
  resetPlaybackClock(opts?.time ?? 0);
  patch({
    current: fresh,
    visible: true,
    playing: false,
    currentTime: opts?.time ?? 0,
    duration: 0,
  });

  audio.pause();
  audio.preload = "auto";
  audio.preservesPitch = true;
  releaseWarmer(fresh.src);
  audio.src = fresh.src;
  audio.playbackRate = state.playbackRate;
  audio.volume = state.volume;
  applyPendingSeek(audio);
  if (fresh.kind === "voice") probeExactDuration(fresh.src);
  const upcoming = peekAdjacentTrack(1, fresh);
  if (upcoming) prefetchAudioSrc(upcoming.src);

  try {
    await audio.play();
  } catch {
    patch({ playing: false });
  }
}

export function toggleAudioPlayback() {
  const audio = getAudio();
  if (!audio || !state.current) return;
  if (audio.paused) {
    void audio.play().catch(() => patch({ playing: false }));
    return;
  }
  audio.pause();
}

export function seekAudioPlayback(time: number) {
  const audio = getAudio();
  pendingSeek = time;
  resetPlaybackClock(Math.max(time, 0));
  patch({ currentTime: Math.max(time, 0) });
  if (!audio?.src) return;
  applyPendingSeek(audio);
}

export function setAudioPlaybackRate(rate: number) {
  const next = PLAYBACK_RATES.includes(rate as PlaybackRate) ? rate : 1;
  const audio = getAudio();
  if (audio) {
    audio.preservesPitch = true;
    audio.playbackRate = next;
  }
  resetPlaybackClock();
  patch({ playbackRate: next });
  persistPrefs();
}

export function cycleAudioPlaybackRate() {
  const idx = PLAYBACK_RATES.indexOf(state.playbackRate as PlaybackRate);
  const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
  setAudioPlaybackRate(next);
}

export function setAudioVolume(volume: number) {
  const next = Math.min(1, Math.max(0, Number(volume.toFixed(2))));
  if (next > 0) lastAudibleVolume = next;
  const audio = getAudio();
  if (audio) audio.volume = next;
  patch({ volume: next });
  persistPrefs();
}

export function toggleAudioMute() {
  if (state.volume > 0) {
    lastAudibleVolume = state.volume;
    setAudioVolume(0);
    return;
  }
  setAudioVolume(lastAudibleVolume > 0 ? lastAudibleVolume : 1);
}

export function skipAudioPlayback(direction: 1 | -1) {
  const next = peekAdjacentTrack(direction);
  if (!next) return;
  void playAudioTrack(next);
}

export function stopAudioPlayback() {
  closing = true;
  pendingSeek = null;
  durationSource = "none";
  resetPlaybackClock(0);
  const audio = getAudio();
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  patch({
    current: null,
    playing: false,
    currentTime: 0,
    duration: 0,
    visible: false,
  });
}

export function formatPlaybackTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
