const KEY = "pulse-media-resume";
const ROOM_KEY = "pulse-last-room";
const MAX_AGE_MS = 10 * 60_000;

export type MediaResume =
  | {
      kind: "call";
      peerId: string;
      peerName: string;
      chatId: string;
      mode: "audio" | "video";
      muted: boolean;
      cameraOff: boolean;
      deafened?: boolean;
      callId?: string;
      connectedAt?: number;
      sharingScreen?: boolean;
      at: number;
    }
  | {
      kind: "voice";
      channelId: string;
      groupId: string;
      title: string;
      muted: boolean;
      deafened: boolean;
      cameraOff: boolean;
      sharingScreen?: boolean;
      at: number;
    };

type CallResumeInput = Omit<Extract<MediaResume, { kind: "call" }>, "at">;
type VoiceResumeInput = Omit<Extract<MediaResume, { kind: "voice" }>, "at">;

let pageUnloading = false;
const liveMedia = { call: false, voice: false };
const reloadBlocked = { call: false, voice: false };

const persistHooks = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    pageUnloading = true;
  });
}

/** Keep resume snapshot through a deploy reload. */
export function markPageUnloading() {
  pageUnloading = true;
}

export function registerMediaResumePersist(fn: () => void) {
  persistHooks.add(fn);
  return () => {
    persistHooks.delete(fn);
  };
}

export function persistLiveMediaNow() {
  for (const fn of persistHooks) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

export function isPageUnloading() {
  return pageUnloading;
}

/** True while a 1:1 call or group voice session is open in this tab. */
export function setLiveMediaSession(kind: "call" | "voice", on: boolean, reloadable = true) {
  liveMedia[kind] = on;
  reloadBlocked[kind] = on && !reloadable;
}

export function hasLiveMediaSession() {
  return liveMedia.call || liveMedia.voice;
}

/** Screen capture requires a fresh user gesture; ringing must not auto-answer. */
export function canReloadLiveMedia() {
  if (!hasLiveMediaSession()) return true;
  if (reloadBlocked.call || reloadBlocked.voice) return false;
  const resume = peekMediaResume();
  if (!resume || resume.sharingScreen) return false;
  if (liveMedia.call) return resume.kind === "call" && Boolean(resume.callId && resume.connectedAt);
  return resume.kind === "voice";
}

export function saveMediaResume(session: CallResumeInput | VoiceResumeInput) {
  if (typeof window === "undefined") return;
  try {
    const payload = { ...session, at: Date.now() } as MediaResume;
    sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function peekMediaResume(): MediaResume | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MediaResume;
    if (!parsed || (parsed.kind !== "call" && parsed.kind !== "voice")) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    if (!parsed.at || Date.now() - parsed.at > MAX_AGE_MS) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export type LastRoom = {
  chatId: string;
  panel?: string;
};

export function saveLastRoom(chatId: string, panel?: string) {
  if (typeof window === "undefined" || !chatId) return;
  try {
    const payload: LastRoom & { at: number } = {
      chatId,
      panel,
      at: Date.now(),
    };
    sessionStorage.setItem(ROOM_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function peekLastRoom(): LastRoom | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastRoom;
    if (!parsed?.chatId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function forgetLastRoom(chatId: string) {
  const last = peekLastRoom();
  if (last?.chatId !== chatId && last?.panel !== chatId) return;
  try { sessionStorage.removeItem(ROOM_KEY); } catch { /* unavailable storage */ }
}

export function clearMediaResume() {
  if (typeof window === "undefined") return;
  if (pageUnloading) return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
