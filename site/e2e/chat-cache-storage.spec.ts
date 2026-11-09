import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type { PersistentChatCache } from "../src/lib/chatCache";
import type { AuthAccount, ChatInfo, ChatMessage } from "../src/lib/types";

declare global {
  interface Window {
    cacheStorage: { open: typeof PersistentChatCache.open; account: AuthAccount; chat: ChatInfo; message: ChatMessage };
  }
}

test.use({ channel: "msedge" });
let bundle = "";
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    import { PersistentChatCache } from './src/lib/chatCache';
    window.cacheStorage = { open: token => PersistentChatCache.open(token),
      account: { token: 'secret-token-A', userId: 'A', username: 'alice', displayName: 'Alice', bio: '' },
      chat: { id: 'room', type: 'group', title: 'Room', topic: '', online: 0, members: 1,
        messages: 1, unreadCount: 0, pinned: false, createdAt: 1, lastMessage: null },
      message: { id: 'm', room: 'room', author: 'Alice', text: 'Saved', createdAt: 1 } };
  ` }, bundle: true, write: false, platform: "browser" });
  bundle = result.outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  await page.route("**/cache-storage-harness", route => route.fulfill({ contentType: "text/html", body: "<p>Cache storage checks</p>" }));
  await page.goto("http://127.0.0.1:3000/cache-storage-harness");
  await page.addScriptTag({ content: bundle });
});

test("real IndexedDB persists a session without storing its bearer token", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { open, account, chat, message } = window.cacheStorage;
    const first = (await open(account.token))!;
    first.setAccount(account); first.setChats([chat]);
    first.setRoom({ chatId: chat.id, messages: [message], before: null, hasMore: false, peerReadAt: 1, savedAt: Date.now() });
    first.setLastRoom(chat.id); await first.flush(); first.close();
    const next = (await open(account.token))!;
    const data = next.read(); next.close();
    const other = (await open("secret-token-B"))!;
    const isolated = other.read(); other.close();
    return { data, isolated };
  });
  expect(result.data?.rooms[0].messages[0].text).toBe("Saved");
  expect(result.data?.lastRoom).toBe("room");
  expect(JSON.stringify(result.data)).not.toContain("secret-token-A");
  expect(result.isolated).toBeNull();
});

test("logout tombstone prevents another tab's delayed writes from resurrecting data", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { open, account, chat } = window.cacheStorage;
    const first = (await open(account.token))!;
    first.setAccount(account); first.setChats([chat]); await first.flush();
    const staleTab = (await open(account.token))!;
    staleTab.setChats([{ ...chat, title: "Delayed stale write" }]);
    await first.revoke();
    await staleTab.flush(); staleTab.close();
    const restored = await open(account.token);
    return restored === null;
  });
  expect(result).toBe(true);
});

test("quota failure is harmless and a later successful write recovers", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { open, account, chat } = window.cacheStorage;
    const cache = (await open(account.token))!;
    cache.setAccount(account); cache.setChats([chat]); await cache.flush();
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException("Full", "QuotaExceededError"); };
    cache.setChats([{ ...chat, title: "Recovered" }]);
    try { await cache.flush(); } finally { IDBObjectStore.prototype.put = original; }
    await cache.flush(); cache.close();
    const restored = (await open(account.token))!;
    const title = restored.read()?.chats[0].title; restored.close();
    return title;
  });
  expect(result).toBe("Recovered");
});

test("room count is bounded and membership changes remove cached history", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { open, account, chat, message } = window.cacheStorage;
    const cache = (await open(account.token))!;
    const chats = Array.from({ length: 25 }, (_, index) => ({ ...chat, id: `room-${index}` }));
    cache.setAccount(account); cache.setChats(chats);
    for (const chat of chats) cache.setRoom({ chatId: chat.id, messages: [{ ...message, room: chat.id }], before: null, hasMore: false, peerReadAt: null, savedAt: Date.now() });
    const count = cache.read()!.rooms.length;
    cache.setLastRoom("room-24"); cache.setChats([chats[23]]); await cache.flush(); cache.close();
    const restored = (await open(account.token))!;
    const data = restored.read(); restored.close();
    return { count, rooms: data?.rooms.map(room => room.chatId), last: data?.lastRoom };
  });
  expect(result).toEqual({ count: 20, rooms: ["room-23"], last: null });
});
