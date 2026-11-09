import type { AuthAccount, ChatInfo, ChatMessage } from "./types";

export const CHAT_CACHE_DB = "maiko-chat-cache";
export const CHAT_CACHE_TTL = 7 * 24 * 60 * 60_000;
export const CHAT_CACHE_ROOMS = 20;
export const CHAT_CACHE_MESSAGES = 80;
const MAX_BYTES = 4 * 1024 * 1024;
const STORE = "sessions";

export type CachedRoom = {
  chatId: string;
  messages: ChatMessage[];
  before: string | null;
  hasMore: boolean;
  peerReadAt: number | null;
  savedAt: number;
};
export type ChatCacheSnapshot = {
  version: 1;
  savedAt: number;
  account: Omit<AuthAccount, "token">;
  chats: ChatInfo[];
  rooms: CachedRoom[];
  lastRoom: string | null;
};
type RecordValue = { key: string; snapshot?: ChatCacheSnapshot; revoked?: boolean };

export function cachedRoomIds(chats: ChatInfo[]) {
  return new Set(chats.flatMap(chat => [chat.id, ...(chat.textChannels ?? []).map(channel => channel.id)]));
}

/** Persist server messages only, without upload progress or local object URLs. */
export function cacheRoom(room: CachedRoom): CachedRoom {
  const confirmed = room.messages.filter(message => message.room === room.chatId && !message.status &&
    ![message.file?.url, ...(message.files ?? []).map(file => file.url), message.sticker?.url]
      .some(url => url && /^(blob:|data:)/i.test(url)));
  const messages = confirmed.slice(-CHAT_CACHE_MESSAGES).map(message => {
    const result = { ...message };
    delete result.clientKey;
    delete result.status;
    delete result.uploadProgress;
    delete result.uploadFileProgress;
    if (result.transcriptionStatus === "pending") delete result.transcriptionStatus;
    return result;
  });
  return { ...room, messages, before: messages[0]?.id ?? null,
    hasMore: room.hasMore || confirmed.length > messages.length };
}

/** Cached presence is never presented as live presence after a restart. */
export function cacheChats(chats: ChatInfo[]) {
  return chats.slice(0, 256).map(chat => ({ ...chat, online: 0,
    voiceChannels: chat.voiceChannels?.map(channel => ({ ...channel, users: [] })) }));
}

export function readChatCache(value: unknown, now = Date.now()): ChatCacheSnapshot | null {
  try {
    const snapshot = value as ChatCacheSnapshot;
    if (!snapshot || snapshot.version !== 1 || !Number.isFinite(snapshot.savedAt) ||
      now - snapshot.savedAt > CHAT_CACHE_TTL || snapshot.savedAt > now + 60_000 ||
      !snapshot.account || typeof snapshot.account.userId !== "string" ||
      typeof snapshot.account.username !== "string" || typeof snapshot.account.displayName !== "string" ||
      !Array.isArray(snapshot.chats) || !Array.isArray(snapshot.rooms)) return null;
    if (snapshot.chats.some(chat => !chat || typeof chat.id !== "string" || typeof chat.title !== "string" ||
      !["group", "dm", "channel"].includes(chat.type) ||
      chat.textChannels !== undefined && !Array.isArray(chat.textChannels) ||
      chat.voiceChannels !== undefined && !Array.isArray(chat.voiceChannels))) return null;
    const chats = cacheChats(snapshot.chats);
    const allowed = cachedRoomIds(chats);
    const rooms = snapshot.rooms.filter(room => room && allowed.has(room.chatId) &&
      Number.isFinite(room.savedAt) && now - room.savedAt <= CHAT_CACHE_TTL &&
      Array.isArray(room.messages) && room.messages.every(message => message &&
        typeof message.id === "string" && message.room === room.chatId &&
        typeof message.text === "string" && typeof message.author === "string" &&
        Number.isFinite(message.createdAt))).slice(0, CHAT_CACHE_ROOMS).map(cacheRoom);
    const { userId, username, displayName, avatarUrl, bio } = snapshot.account;
    return { version: 1, savedAt: snapshot.savedAt,
      account: { userId, username, displayName, avatarUrl, bio: typeof bio === "string" ? bio : "" },
      chats, rooms, lastRoom: typeof snapshot.lastRoom === "string" && allowed.has(snapshot.lastRoom) ? snapshot.lastRoom : null };
  } catch { return null; }
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) return null;
  return new Promise(resolve => {
    let finished = false;
    const finish = (db: IDBDatabase | null) => { if (!finished) { finished = true; clearTimeout(timer); resolve(db); } else db?.close(); };
    const timer = setTimeout(() => finish(null), 1500);
    try {
      const request = indexedDB.open(CHAT_CACHE_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); finish(request.result); };
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch { finish(null); }
  });
}

/** One session fingerprint, no second copy of the bearer token in IndexedDB. */
export class PersistentChatCache {
  private snapshot: ChatCacheSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private constructor(private db: IDBDatabase, private key: string) {}

  static async open(token: string): Promise<PersistentChatCache | null> {
    try {
      const db = await openDatabase();
      if (!db) return null;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const cache = new PersistentChatCache(db, key);
      const record = await new Promise<RecordValue | undefined>((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (record?.revoked) { db.close(); return null; }
      cache.snapshot = readChatCache(record?.snapshot);
      return cache;
    } catch { return null; }
  }

  read() { return this.snapshot; }

  setAccount(account: AuthAccount) {
    const { userId, username, displayName, avatarUrl, bio } = account;
    if (this.snapshot?.account.userId !== userId) this.snapshot = null;
    this.snapshot = { version: 1, savedAt: Date.now(), chats: [], rooms: [], lastRoom: null,
      ...this.snapshot, account: { userId, username, displayName, avatarUrl, bio } };
    this.schedule();
  }

  setChats(chats: ChatInfo[]) {
    if (!this.snapshot) return;
    this.snapshot.chats = cacheChats(chats);
    const allowed = cachedRoomIds(this.snapshot.chats);
    this.snapshot.rooms = this.snapshot.rooms.filter(room => allowed.has(room.chatId));
    if (this.snapshot.lastRoom && !allowed.has(this.snapshot.lastRoom)) this.snapshot.lastRoom = null;
    this.schedule();
  }

  setRoom(room: CachedRoom) {
    if (!this.snapshot || !cachedRoomIds(this.snapshot.chats).has(room.chatId)) return;
    this.snapshot.rooms = [cacheRoom(room), ...this.snapshot.rooms.filter(item => item.chatId !== room.chatId)]
      .slice(0, CHAT_CACHE_ROOMS);
    this.schedule();
  }

  patchRoom(chatId: string, patch: (messages: ChatMessage[]) => ChatMessage[]) {
    const room = this.snapshot?.rooms.find(room => room.chatId === chatId);
    if (room) this.setRoom({ ...room, messages: patch(room.messages) });
  }

  removeRoom(chatId: string) {
    if (!this.snapshot) return;
    this.snapshot.rooms = this.snapshot.rooms.filter(room => room.chatId !== chatId);
    if (this.snapshot.lastRoom === chatId) this.snapshot.lastRoom = null;
    this.schedule();
  }

  setLastRoom(chatId: string) {
    if (!this.snapshot || !cachedRoomIds(this.snapshot.chats).has(chatId) || this.snapshot.lastRoom === chatId) return;
    this.snapshot.lastRoom = chatId;
    this.schedule();
  }

  private schedule() {
    if (!this.closed && !this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 250);
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.closed || !this.snapshot) return;
    try {
      this.snapshot.savedAt = Date.now();
      // Count each room once; trimming must not repeatedly serialize the history.
      let bytes = JSON.stringify({ ...this.snapshot, rooms: [] }).length * 2;
      if (bytes > MAX_BYTES) return;
      this.snapshot.rooms = this.snapshot.rooms.filter(room => {
        bytes += JSON.stringify(room).length * 2;
        return bytes <= MAX_BYTES;
      });
      const snapshot = this.snapshot;
      await new Promise<void>((resolve, reject) => {
        const transaction = this.db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        const previous = store.get(this.key);
        previous.onsuccess = () => {
          // A logout in another tab, including a queued write, cannot resurrect data.
          try {
            if (!(previous.result as RecordValue | undefined)?.revoked) store.put({ key: this.key, snapshot });
          } catch { transaction.abort(); }
        };
        const records = store.getAll();
        records.onsuccess = () => {
          const active = (records.result as RecordValue[]).filter(record => record.key !== this.key && !record.revoked)
            .sort((a, b) => (b.snapshot?.savedAt ?? 0) - (a.snapshot?.savedAt ?? 0));
          for (const [index, record] of active.entries()) {
            if (index >= 2 || Date.now() - (record.snapshot?.savedAt ?? 0) > CHAT_CACHE_TTL) store.delete(record.key);
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch { /* Cache failure must never interrupt chat or authentication. */ }
  }

  async revoke() {
    this.close();
    // close() prevents later writes; use a separate connection for the tombstone.
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ key: this.key, revoked: true });
        tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
      } catch { db.close(); resolve(); }
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.db.close();
  }
}
