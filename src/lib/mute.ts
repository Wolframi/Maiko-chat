const MUTE_KEY = "pulse-muted-chats";

function readMuted(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MUTE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function writeMuted(ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MUTE_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

export function isChatMuted(chatId: string) {
  return readMuted().includes(chatId);
}

export function setChatMuted(chatId: string, muted: boolean) {
  const current = new Set(readMuted());
  if (muted) current.add(chatId);
  else current.delete(chatId);
  writeMuted([...current]);
}

export function toggleChatMuted(chatId: string) {
  const next = !isChatMuted(chatId);
  setChatMuted(chatId, next);
  return next;
}
