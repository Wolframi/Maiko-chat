import assert from "node:assert/strict";
import { test } from "node:test";
import { MongoClient } from "mongodb";
import { io, type Socket } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";

test("MongoDB serves pages and old message operations without an in-memory history", {
  skip: !process.env.TEST_MONGODB_URI, timeout: 180_000,
}, async () => {
  const uri = process.env.TEST_MONGODB_URI!;
  const database = `maiko_test_history_${Date.now()}`;
  const admin = new MongoClient(uri);
  const server = await securityServer({ historyMessages: 2500, mongo: { uri, database } });
  const sockets: Socket[] = [];
  const lastMutation = new WeakMap<Socket, number>();
  async function request(socket: Socket, event: string, payload: unknown): Promise<any> {
    if ((event === "message" || event.startsWith("message:")) && event !== "message:react") {
      const wait = 220 - (Date.now() - (lastMutation.get(socket) ?? 0));
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      lastMutation.set(socket, Date.now());
    }
    return socket.timeout(15_000).emitWithAck(event, payload);
  }
  async function connect(user: number) {
    const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false, auth: { historyPages: 1, chatPatches: 1 } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    assert.equal((await request(socket, "auth:login", { username: `seeduser${user}`, password: server.password })).ok, true);
    return socket;
  }
  async function open(socket: Socket, chatId: string) {
    const history = new Promise<any>(resolve => socket.once("history", resolve));
    assert.equal((await request(socket, "chats:switch", { chatId })).ok, true);
    return history;
  }
  try {
    const a = await connect(0), b = await connect(1);
    const chatId = "security-group-0";
    const page = await open(a, chatId);
    await open(b, chatId);
    assert.equal(page.messages.length, 80);
    assert.equal(page.messages[0].id, "history-2420");
    assert.equal(page.messages.at(-1).replyTo.id, "history-12", "reply source is outside the loaded page");
    assert.equal((await request(a, "history:load", { chatId, before: "history-5" })).ok, false);
    assert.equal((await request(a, "history:load", { chatId, before: "missing" })).ok, false);
    assert.equal((await request(a, "history:load", { chatId: "security-group-1" })).ok, false);
    assert.equal((await request(a, "message:edit", { chatId, messageId: "history-12", text: "edited old reply" })).ok, true);
    const sent = await request(a, "message", { chatId, clientId: "mongo-dedupe", text: "new reply", replyToId: "history-12" });
    assert.equal(sent.ok, true, sent.error);
    assert.equal(sent.message.replyTo.text, "edited old reply");
    const duplicate = await request(a, "message", { chatId, clientId: "mongo-dedupe", text: "retry" });
    assert.equal(duplicate.message.id, sent.message.id);
    const reactions = await Promise.all([
      request(a, "message:react", { chatId, messageId: "history-12", emoji: "👍" }),
      request(b, "message:react", { chatId, messageId: "history-12", emoji: "❤️" }),
    ]);
    assert.ok(reactions.every(result => result.ok));
    const collection = admin.db(database).collection("messages");
    const old = await collection.findOne({ _id: JSON.stringify([chatId, "history-12"]) as any });
    assert.equal(old!.message.reactions.length, 2, "concurrent reactions preserve both users");
    assert.equal((await request(a, "message:pin", { chatId, messageId: "history-12" })).ok, true);
    assert.equal((await request(a, "message:pin", { chatId, messageId: sent.message.id })).ok, true);
    assert.equal((await collection.findOne({ _id: old!._id }))!.message.pinned, false);
    const deleted = await request(a, "message:delete", { chatId, messageId: "history-12" });
    assert.equal(deleted.ok, true, JSON.stringify({ deleted, logs: server.logs() }));
    assert.equal((await collection.findOne({ "message.id": sent.message.id }))!.message.replyTo.text, "Сообщение удалено");
    const earlier = await request(a, "history:load", { chatId, before: "history-80" });
    assert.ok(earlier.messages.some((message: any) => message.id === "history-12" && message.kind === "system"));
    assert.ok(!earlier.messages.some((message: any) => message.id === "history-5" || message.id === "history-6"));

    const form = new FormData();
    form.append("file", new Blob(["private database attachment"], { type: "text/plain" }), "database-history.txt");
    const upload = await (await fetch(server.base + "/api/upload", { method: "POST", headers: { "x-pulse-token": server.token, origin: server.base }, body: form })).json();
    assert.ok(upload.file?.url);
    assert.equal((await request(a, "message:file", { chatId, file: upload.file, clientId: "mongo-file" })).ok, true);
    const media = await request(a, "room:media", { chatId, kind: "file", limit: 1 });
    assert.equal(media.total, 1);
    assert.equal(media.items[0].file.name, "database-history.txt");
    assert.equal((await request(a, "message:delete", { chatId, messageId: media.items[0].messageId })).ok, true);
    assert.equal((await request(a, "room:media", { chatId })).total, 0);

    const dm = await request(a, "dm:open", { userId: "security-user-1" });
    const room = dm.session.room;
    await open(b, room);
    const beforeHide = await request(b, "message", { chatId: room, text: "keep peer copy" });
    assert.equal(beforeHide.ok, true);
    assert.equal((await request(a, "dm:delete", { chatId: room, scope: "self" })).ok, true);
    assert.equal((await open(a, room)).messages.length, 0);
    assert.equal((await open(b, room)).messages.length, 1);
    const reply = await request(b, "message", { chatId: room, text: "reply after hide", replyToId: beforeHide.message.id });
    assert.equal(reply.ok, true);
    const visible = await open(a, room);
    assert.equal(visible.messages.length, 1);
    assert.equal(visible.messages[0].replyTo, undefined);
    assert.equal((await request(a, "dm:delete", { chatId: room, scope: "both" })).ok, true);
    assert.equal(await collection.countDocuments({ room }), 0);

    const created = await request(a, "group:create", { title: "Legacy invite expiry", visibility: "public" });
    assert.equal(created.ok, true);
    const groupId = created.session.room;
    // Historical invites can be older than any loaded page. No external writer runs in production.
    await collection.insertOne({ _id: JSON.stringify([room, "legacy-invite"]) as any, room, position: 999, message: {
      id: "legacy-invite", room, author: "Seed User 0", authorId: "security-user-0", kind: "invite",
      text: "legacy pending invite", createdAt: 1, invite: { groupId, groupTitle: "Legacy invite expiry", status: "pending" },
    } });
    // The fixture writes outside the application writer, so discard its derived snapshot.
    await admin.db(database).collection("message_summaries").deleteMany({ room });
    assert.equal((await request(a, "group:delete", { chatId: groupId })).ok, true);
    assert.equal((await collection.findOne({ room, "message.id": "legacy-invite" }))!.message.invite.status, "expired");
    const summaries = admin.db(database).collection("message_summaries");
    assert.equal((await summaries.findOne({ room, viewerId: "security-user-0" }))!.last.text, "Группа «Legacy invite expiry» удалена");
    assert.equal(await summaries.countDocuments({ room: chatId, viewerId: "security-user-0" }), 1);
    assert.equal((await request(a, "group:leave", { chatId })).ok, true);
    assert.equal(await summaries.countDocuments({ room: chatId, viewerId: "security-user-0" }), 0, "leaving a group removes that viewer from summary updates");
    assert.equal(await summaries.countDocuments({ room: chatId, viewerId: "security-user-1" }), 1);
    assert.ok(!server.logs().includes("MongoDB messages must be queried directly"));
    assert.ok(server.logs().includes("history loaded on demand"));
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await server.stop();
    await admin.db(database).dropDatabase();
    await admin.close();
  }
});
