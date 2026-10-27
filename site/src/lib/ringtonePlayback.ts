import { getRingtoneAccount } from "./ringtoneAccount";

const MAX_BYTES = 16 * 1024 * 1024;
const clips = new Map<string, { blob: Blob; expires: number }>();
const pending = new Map<string, Promise<Blob>>();
let owner = "";
let bytes = 0;

export function isProtectedRingtone(url: string) {
  return url.startsWith("/api/ringtones/audio?");
}

/** Fetch with a session header; HTMLAudioElement cannot send custom headers. */
export async function ringtoneBlob(url: string): Promise<Blob> {
  if (!isProtectedRingtone(url)) throw new Error("Некорректный адрес рингтона");
  const token = getRingtoneAccount()?.token;
  if (!token) throw new Error("Сначала войдите в аккаунт");
  if (owner !== token) { clips.clear(); pending.clear(); bytes = 0; owner = token; }
  const cached = clips.get(url);
  if (cached) {
    clips.delete(url);
    bytes -= cached.blob.size;
    if (cached.expires > Date.now()) {
      clips.set(url, cached); bytes += cached.blob.size;
      return cached.blob;
    }
  }
  const existing = pending.get(url);
  if (existing) return existing;
  if (pending.size >= 8) throw new Error("Дождитесь загрузки рингтона");
  const job = (async () => {
    const response = await fetch(url, {
      headers: { "x-pulse-token": token }, credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || "Не удалось загрузить рингтон");
    }
    const blob = await response.blob();
    if (owner !== token || getRingtoneAccount()?.token !== token) throw new Error("Аккаунт изменился");
    if (!blob.size || blob.size > 12 * 1024 * 1024) throw new Error("Некорректный размер рингтона");
    while (clips.size >= 20 || bytes + blob.size > MAX_BYTES) {
      const oldest = clips.keys().next().value!;
      bytes -= clips.get(oldest)!.blob.size;
      clips.delete(oldest);
    }
    clips.set(url, { blob, expires: Date.now() + 20 * 60_000 }); bytes += blob.size;
    return blob;
  })().finally(() => { if (pending.get(url) === job) pending.delete(url); });
  pending.set(url, job);
  return job;
}

/** Each player owns its URL so cancelling a preview cannot stop another player. */
export function loadRingtoneAudio(audio: HTMLAudioElement, url: string) {
  let stopped = false;
  let objectUrl: string | undefined;
  const ready = (async () => {
    if (isProtectedRingtone(url)) {
      const blob = await ringtoneBlob(url);
      if (stopped) return false;
      objectUrl = URL.createObjectURL(blob);
      audio.src = objectUrl;
    } else {
      if (stopped) return false;
      audio.src = url;
    }
    return true;
  })().catch(error => { if (stopped) return false; throw error; });
  return {
    ready,
    stop() { stopped = true; if (objectUrl) URL.revokeObjectURL(objectUrl); },
  };
}
