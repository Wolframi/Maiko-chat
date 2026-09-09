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
      at: number;
    };

type CallResumeInput = Omit<Extract<MediaResume, { kind: "call" }>, "at">;
type VoiceResumeInput = Omit<Extract<MediaResume, { kind: "voice" }>, "at">;

let pageUnloading = false;
const liveMedia = { call: false, voice: false };

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    pageUnloading = true;
  });
}

export function isPageUnloading() {
  return pageUnloading;
}

/** True while a 1:1 call or group voice session is open in this tab. */
export function setLiveMediaSession(kind: "call" | "voice", on: boolean) {
  liveMedia[kind] = on;
}

export function hasLiveMediaSession() {
  return liveMedia.call || liveMedia.voice;
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

export function clearMediaResume() {
  if (typeof window === "undefined") return;
  if (pageUnloading) return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
