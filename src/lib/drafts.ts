const DRAFT_KEY = "pulse-drafts";
const MAX_DRAFTS = 80;
const MAX_LEN = 2000;

function readAll(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        out[key] = value.slice(0, MAX_LEN);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(drafts: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    const entries = Object.entries(drafts);
    const trimmed =
      entries.length > MAX_DRAFTS
        ? Object.fromEntries(entries.slice(-MAX_DRAFTS))
        : drafts;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore */
  }
}

export function loadDraft(chatId: string) {
  if (!chatId) return "";
  return readAll()[chatId] || "";
}

export function saveDraft(chatId: string, text: string) {
  if (!chatId) return;
  const drafts = readAll();
  const value = text.slice(0, MAX_LEN);
  if (!value.trim()) {
    if (chatId in drafts) {
      delete drafts[chatId];
      writeAll(drafts);
    }
    return;
  }
  drafts[chatId] = value;
  writeAll(drafts);
}

export function clearDraft(chatId: string) {
  if (!chatId) return;
  const drafts = readAll();
  if (!(chatId in drafts)) return;
  delete drafts[chatId];
  writeAll(drafts);
}
