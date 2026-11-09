import assert from "node:assert/strict";
import test from "node:test";
import { cacheChats, cacheRoom, CHAT_CACHE_TTL, readChatCache } from "../src/lib/chatCache";
import type { ChatCacheSnapshot } from "../src/lib/chatCache";
import type { ChatInfo, ChatMessage } from "../src/lib/types";

const chat: ChatInfo = { id: "group", title: "Group", type: "group", topic: "", online: 2,
  members: 2, messages: 100, unreadCount: 2, pinned: false, createdAt: 1, lastMessage: null,
  textChannels: [{ id: "child", title: "Child", unreadCount: 0 }],
  voiceChannels: [{ id: "voice", title: "Voice", users: [{ userId: "u", name: "User", muted: false, deafened: false }] }] };
const message = (index: number): ChatMessage => ({ id: String(index), room: "group", author: "User", text: `Message ${index}`, createdAt: index });
const snapshot = (): ChatCacheSnapshot => ({ version: 1, savedAt: Date.now(),
  account: { userId: "u", username: "user", displayName: "User", bio: "" }, chats: [chat],
  lastRoom: "group", rooms: [{ chatId: "group", savedAt: Date.now(), messages: [message(1)], before: "1", hasMore: false, peerReadAt: null }] });

test("cache keeps a bounded contiguous tail and excludes unfinished uploads", () => {
  const messages = Array.from({ length: 100 }, (_, index) => message(index));
  messages.push({ ...message(100), status: "pending" }, { ...message(101), status: "failed" },
    { ...message(102), file: { url: "blob:local", name: "photo", mime: "image/png", size: 1 } },
    { ...message(103), room: "another-room" });
  const cached = cacheRoom({ chatId: "group", messages, hasMore: false, before: null, peerReadAt: null, savedAt: Date.now() });
  assert.equal(cached.messages.length, 80);
  assert.equal(cached.messages[0].id, "20");
  assert.equal(cached.messages.at(-1)?.id, "99");
  assert.equal(cached.before, "20");
  assert.equal(cached.hasMore, true);
});

test("cache drops transient state and does not mutate React snapshots", () => {
  const item = { ...message(1), clientKey: "local", uploadProgress: 1, uploadFileProgress: [1], transcriptionStatus: "pending" as const };
  const cached = cacheRoom({ ...snapshot().rooms[0], messages: [item] }).messages[0];
  assert.equal(cached.clientKey, undefined);
  assert.equal(cached.transcriptionStatus, undefined);
  assert.equal(cached.uploadProgress, undefined);
  assert.equal(item.uploadProgress, 1);
  const chats = cacheChats([chat]);
  assert.equal(chats[0].online, 0);
  assert.deepEqual(chats[0].voiceChannels?.[0].users, []);
  assert.equal(chat.voiceChannels?.[0].users.length, 1);
});

test("obsolete schemas, expired or malformed data are ignored", () => {
  assert.equal(readChatCache(null), null);
  assert.equal(readChatCache({ ...snapshot(), version: 2 }), null);
  assert.equal(readChatCache({ ...snapshot(), savedAt: Date.now() - CHAT_CACHE_TTL - 1 }), null);
  assert.equal(readChatCache({ ...snapshot(), savedAt: Date.now() + 120_000 }), null);
  assert.equal(readChatCache({ ...snapshot(), chats: [{}] }), null);
  assert.equal(readChatCache({ ...snapshot(), rooms: [{}] })?.rooms.length, 0);
});

test("restoring removes inaccessible rooms and never restores a stored bearer token", () => {
  const data = snapshot();
  data.rooms.push({ ...data.rooms[0], chatId: "removed", messages: [{ ...message(2), room: "removed" }] });
  data.rooms.push({ ...data.rooms[0], chatId: "child", messages: [{ ...message(3), room: "child" }] });
  data.lastRoom = "removed";
  const result = readChatCache({ ...data, account: { ...data.account, token: "must-not-be-copied" } });
  assert.deepEqual(result?.rooms.map(room => room.chatId), ["group", "child"]);
  assert.equal(result?.lastRoom, null);
  assert.equal("token" in result!.account, false);
});
