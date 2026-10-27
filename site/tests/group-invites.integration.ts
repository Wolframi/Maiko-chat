import assert from "node:assert/strict";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";

test("closed groups can be joined by the current code, which only members can read", { timeout: 90000 }, async () => {
  const server = await securityServer();
  const clients: Socket[] = [];
  const emit = (socket: Socket, event: string, payload: unknown): Promise<any> => socket.timeout(10000).emitWithAck(event, payload);
  const connect = async () => {
    const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    return socket;
  };
  try {
    const owner = await connect();
    const guest = await connect();
    const anonymous = await connect();
    assert.equal((await emit(owner, "auth:restore", { token: server.token })).ok, true);
    assert.equal((await emit(guest, "auth:login", { username: "seeduser2", password: server.password })).ok, true);
    const created = await emit(owner, "group:create", { title: "Closed code fixture", visibility: "private" });
    assert.equal(created.ok, true);
    const groupId = created.session.room;
    const code = await emit(owner, "group:code", { groupId });
    assert.equal(code.ok, true);
    assert.equal((await emit(anonymous, "group:code", { groupId })).ok, false);
    assert.equal((await emit(anonymous, "group:join-code", { code: code.invite.code })).ok, false);
    assert.equal((await emit(guest, "group:code", { groupId })).ok, false);
    assert.equal((await emit(guest, "group:join", { groupId })).ok, false);
    assert.deepEqual((await emit(guest, "groups:search", { query: "Closed code fixture" })).groups, []);
    assert.equal((await emit(owner, "group:invite", { groupId, userId: "security-user-2" })).ok, false);
    assert.equal((await emit(guest, "group:join-code", { code: "INVALID" })).ok, false);
    const joined = await emit(guest, "group:join-code", { code: code.invite.code.toLowerCase().replaceAll("-", " ") });
    assert.equal(joined.ok, true, joined.error);
    assert.equal(joined.session.room, groupId);
    assert.equal((await emit(guest, "group:code", { groupId })).invite.code, code.invite.code);
    const failures = [];
    for (let attempt = 0; attempt < 9; attempt++) failures.push(await emit(guest, "group:join-code", { code: "INVALID" }));
    assert.ok(failures.some(result => /много попыток/.test(result.error)));
    assert.equal((await (await fetch(server.base + "/api/health")).json()).ok, true);
  } finally {
    for (const socket of clients) socket.disconnect();
    await server.stop();
  }
});
