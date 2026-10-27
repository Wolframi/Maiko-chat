import assert from "node:assert/strict";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";

function once(socket: Socket, event: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const receive = (...args: unknown[]) => { clearTimeout(timer); resolve(args); };
    const timer = setTimeout(() => { socket.off(event, receive); reject(new Error(`Timed out waiting for ${event}`)); }, 10_000);
    socket.once(event, receive);
  });
}

test("DM removal isolates copies, persists history visibility and synchronizes sessions; group owners can leave", { timeout: 180_000 }, async () => {
  const server = await securityServer();
  const clients: Socket[] = [];
  async function client(user: number) {
    const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false,
      auth: { historyPages: 1, chatPatches: 1 } });
    clients.push(socket);
    await once(socket, "connect");
    const result = await emit(socket, "auth:login", { username: `seeduser${user}`, password: server.password });
    assert.equal(result.ok, true, result.error);
    return socket;
  }
  const emit = (socket: Socket, event: string, payload: unknown): Promise<any> => socket.timeout(10_000).emitWithAck(event, payload);
  async function history(socket: Socket, chatId: string) {
    const received = once(socket, "history");
    assert.equal((await emit(socket, "chats:switch", { chatId })).ok, true);
    return (await received)[0].messages as Array<Record<string, any>>;
  }
  try {
    const a = await client(0);
    const otherSession = await client(0);
    const b = await client(1);
    const outsider = await client(2);
    const opened = await emit(a, "dm:open", { userId: "security-user-1" });
    assert.equal(opened.ok, true);
    const chatId = opened.session.room;
    await history(b, chatId);
    await history(otherSession, chatId);
    const sent = await emit(b, "message", { chatId, text: "peer's old history", clientId: "old-history" });
    assert.equal(sent.ok, true, sent.error);
    const oldId = sent.message.id;
    const form = new FormData();
    form.append("file", new Blob(["private old file"], { type: "text/plain" }), "history.txt");
    const uploaded = await (await fetch(server.base + "/api/upload", { method: "POST", headers: { "x-pulse-token": server.token, origin: server.base }, body: form })).json();
    assert.ok(uploaded.file?.url, JSON.stringify(uploaded));
    assert.equal((await emit(a, "message:file", { chatId, file: uploaded.file, clientId: "old-file" })).ok, true);
    assert.equal((await emit(a, "room:media", { chatId })).total, 1);
    assert.equal((await emit(outsider, "dm:delete", { chatId, scope: "both" })).ok, false);
    assert.equal((await emit(a, "dm:delete", { chatId, scope: "invalid" })).ok, false);
    const hiddenInOtherSession = once(otherSession, "chat:left");
    assert.equal((await emit(a, "dm:delete", { chatId, scope: "self" })).ok, true);
    assert.equal((await hiddenInOtherSession)[0].chatId, chatId);
    assert.equal((await emit(a, "room:media", { chatId })).total, 0);
    assert.equal((await emit(b, "room:media", { chatId })).total, 1);
    assert.deepEqual(await history(a, chatId), []);
    assert.equal((await history(b, chatId)).length, 2);
    assert.equal((await emit(a, "message:forward", { fromChatId: chatId, messageId: oldId, toChatId: chatId })).ok, false);
    assert.equal((await emit(a, "message:react", { chatId, messageId: oldId, emoji: "👍" })).ok, false);
    const updates: unknown[] = [];
    a.on("message:update", item => updates.push(item));
    assert.equal((await emit(b, "message:edit", { chatId, messageId: oldId, text: "edited hidden history" })).ok, true);
    assert.equal(updates.length, 0);
    const fresh = await emit(b, "message", { chatId, text: "new visible message", replyToId: oldId });
    assert.equal(fresh.ok, true);
    const aHistory = await history(a, chatId);
    assert.equal(aHistory.length, 1);
    assert.equal(aHistory[0].text, "new visible message");
    assert.equal(aHistory[0].replyTo, undefined);
    assert.ok(!("hiddenFor" in aHistory[0]));
    const bHistory = await history(b, chatId);
    assert.equal(bHistory.length, 3);
    assert.equal(bHistory[2].replyTo.text, "edited hidden history");
    const removedFromPeer = once(b, "chat:left");
    assert.equal((await emit(a, "dm:delete", { chatId, scope: "both" })).ok, true);
    await removedFromPeer;
    assert.deepEqual(await history(a, chatId), []);
    assert.deepEqual(await history(b, chatId), []);
    const group = await emit(a, "group:create", { title: "Owner leaves", visibility: "public" });
    assert.equal(group.ok, true);
    const groupId = group.session.room;
    assert.equal((await emit(b, "group:join", { groupId })).ok, true);
    const text = await emit(a, "text:create", { groupId, title: "other-room" });
    assert.equal(text.ok, true, text.error);
    await history(otherSession, text.channel.id);
    const leftTextRoom = once(otherSession, "chat:left");
    assert.equal((await emit(a, "group:leave", { chatId: groupId })).ok, true);
    assert.equal((await leftTextRoom)[0].chatId, text.channel.id);
    assert.equal((await emit(a, "chats:switch", { chatId: groupId })).ok, false);
    assert.equal((await emit(b, "group:update", { chatId: groupId, title: "New owner" })).ok, true);
    assert.equal((await emit(b, "group:leave", { chatId: groupId })).ok, true);
    assert.equal((await emit(b, "group:join", { groupId })).ok, false);
  } finally {
    for (const socket of clients) socket.disconnect();
    await server.stop();
  }
});
