import assert from "node:assert/strict";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";

function once(socket: Socket, event: string, matches: (value: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, receive); reject(new Error(`Timeout: ${event}`)); }, 15_000);
    const receive = (value: unknown) => {
      if (!matches(value)) return;
      socket.off(event, receive);
      clearTimeout(timer); resolve(value);
    };
    socket.on(event, receive);
  });
}

test("paged history and chat patches coexist with legacy clients and enforce history visibility", { timeout: 180_000 }, async () => {
  const server = await securityServer({ historyMessages: 250 });
  const clients: Socket[] = [];
  async function connect(modern: boolean) {
    const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false, auth: modern ? { historyPages: 1, chatPatches: 1 } : {} });
    clients.push(socket);
    await once(socket, "connect");
    assert.equal((await socket.timeout(15_000).emitWithAck("auth:restore", { token: server.token })).ok, true);
    return socket;
  }
  try {
    const modern = await connect(true), legacy = await connect(false);
    const request = (socket: Socket, event: string, payload: unknown) => socket.timeout(15_000).emitWithAck(event, payload);
    const history = once(modern, "history");
    assert.equal((await request(modern, "chats:switch", { chatId: "security-group-0" })).ok, true);
    let page = await history;
    assert.equal(page.messages.length, 80);
    assert.equal(page.messages[0].id, "history-170");
    assert.equal(page.hasMore, true);
    const ids = page.messages.map((message: any) => message.id);
    while (page.hasMore) {
      page = await request(modern, "history:load", { chatId: "security-group-0", before: page.before });
      assert.equal(page.ok, true, page.error);
      ids.unshift(...page.messages.map((message: any) => message.id));
    }
    assert.equal(ids.length, 248);
    assert.equal(new Set(ids).size, 248);
    assert.equal(ids.includes("history-5"), false);
    assert.equal(ids.includes("history-6"), false);
    const full = await request(modern, "history:load", { chatId: "security-group-0", all: true });
    assert.equal(full.messages.length, 248);
    assert.equal((await request(modern, "history:load", { chatId: "security-group-1" })).ok, false);
    assert.equal((await request(modern, "history:load", { chatId: "security-group-0", before: "history-5" })).ok, false);
    const chatId = "security-group-0";
    const search = await request(modern, "history:search", { chatId, query: "History message" });
    assert.equal(search.ok, true, search.error);
    assert.equal(search.ids.length, 40);
    assert.equal(search.hasMore, true);
    assert.equal(search.ids.includes("history-5"), false);
    assert.equal(search.ids.includes("history-6"), false);
    assert.equal(search.messages, undefined, "search transfers IDs only");
    const nextSearch = await request(modern, "history:search", { chatId, query: "History message", after: search.after });
    assert.equal(nextSearch.ids[0], "history-42");
    assert.equal((await request(modern, "history:search", { chatId, query: ".*" })).ids.length, 0);
    assert.equal((await request(modern, "history:search", { chatId, query: "x".repeat(201) })).ok, false);
    const window = await request(modern, "history:load", { chatId, around: "history-125" });
    assert.equal(window.ok, true, window.error);
    assert.equal(window.messages.length, 81);
    assert.equal(window.before, "history-85");
    assert.equal(window.after, "history-165");
    assert.equal(window.hasMore, true);
    assert.equal(window.hasNewer, true);
    const newer = await request(modern, "history:load", { chatId, after: window.after });
    assert.equal(newer.messages.length, 80);
    assert.equal(newer.messages[0].id, "history-166");
    assert.equal(newer.after, "history-245");
    assert.equal(newer.hasNewer, true);
    for (const id of ["history-5", "history-6", "missing"]) {
      assert.equal((await request(modern, "history:load", { chatId, around: id })).ok, false);
      assert.equal((await request(modern, "history:load", { chatId, after: id })).ok, false);
      assert.equal((await request(modern, "history:search", { chatId, query: "History", after: id })).ok, false);
    }
    for (const event of ["history:load", "history:search"]) {
      assert.equal((await request(modern, event, { chatId: "security-group-1", around: "history-125", query: "History" })).ok, false);
    }
    const oldHistory = once(legacy, "history");
    await request(legacy, "chats:switch", { chatId: "security-group-0" });
    assert.equal((await oldHistory).messages.length, 248);
    let fullLists = 0;
    modern.on("chats", () => fullLists++);
    // A previous room switch can still publish its read/presence update. Wait
    // for the sent message's preview, independently of the notification timing.
    const modernUpdate = once(modern, "chat:update", value => value.chat?.lastMessage?.text === "new message after paging");
    const legacyUpdate = once(legacy, "chats", value => value.some((chat: any) => chat.id === chatId && chat.lastMessage?.text === "new message after paging"));
    const sent = await request(modern, "message", { chatId: "security-group-0", text: "new message after paging", clientId: "paging-send" });
    assert.equal(sent.ok, true, sent.error);
    const [update, list] = await Promise.all([modernUpdate, legacyUpdate]);
    assert.equal(update.chatId, "security-group-0");
    assert.equal(update.chat.lastMessage.text, "new message after paging");
    assert.equal(update.chat.messages, 249);
    assert.ok(list.some((chat: any) => chat.id === update.chatId && chat.lastMessage.text === update.chat.lastMessage.text));
    assert.equal(fullLists, 0, "a modern client receives only the changed chat");
  } finally {
    clients.forEach(socket => socket.disconnect());
    await server.stop();
  }
});
