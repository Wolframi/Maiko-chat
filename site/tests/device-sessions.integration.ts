import assert from "node:assert/strict";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";
import type { DeviceSessionsResult } from "../src/lib/deviceSessions";

test("device management disconnects every tab of a revoked session and rejects reuse", { timeout: 120000 }, async () => {
  const server = await securityServer();
  const sockets: Socket[] = [];
  const connect = async (ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36") => {
    const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false,
      extraHeaders: { "user-agent": ua, "x-real-ip": "8.8.8.8" } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    return socket;
  };
  const emit = (socket: Socket, event: string, payload: unknown = {}) => socket.timeout(10000).emitWithAck(event, payload);
  try {
    const current = await connect();
    assert.equal((await emit(current, "auth:devices")).ok, false);
    assert.equal((await emit(current, "auth:device-revoke", { others: true })).ok, false);
    assert.equal((await emit(current, "auth:restore", { token: server.token })).ok, true);
    const mobile = await connect("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148 Safari/604.1");
    const signed = await emit(mobile, "auth:login", { username: "seeduser0", password: server.password });
    assert.equal(signed.ok, true);
    const other = await connect();
    const outsider = await emit(other, "auth:login", { username: "seeduser1", password: server.password });
    assert.equal(outsider.ok, true);
    const clone = await connect();
    assert.equal((await emit(clone, "auth:restore", { token: signed.account.token })).ok, true);
    const list = await emit(current, "auth:devices") as DeviceSessionsResult;
    assert.equal(list.ok, true);
    if (!list.ok) return;
    assert.equal(list.sessions.length, 2);
    assert.equal(list.sessions[0].current, true);
    // A direct client must not be able to spoof the recorded IP via headers.
    assert.equal(list.sessions[0].ip, "127.0.0.1");
    const target = list.sessions.find(session => !session.current)!;
    assert.equal(target.os, "iOS");
    assert.ok(!JSON.stringify(list).includes(signed.account.token));
    assert.equal((await emit(other, "auth:device-revoke", { id: target.id })).ok, false);
    assert.equal((await emit(current, "auth:device-revoke", { id: list.sessions[0].id })).ok, false);
    const expired = [mobile, clone].map(socket => new Promise(resolve => socket.once("auth:expired", resolve)));
    assert.equal((await emit(current, "auth:device-revoke", { id: target.id })).ok, true);
    await Promise.all(expired);
    const retry = await connect();
    assert.equal((await emit(retry, "auth:restore", { token: signed.account.token })).ok, false);
    const response = await fetch(server.base + "/api/ice", { headers: { "x-pulse-token": signed.account.token } });
    assert.equal(response.status, 401);
    assert.equal((await emit(other, "auth:devices")).ok, true);
    const next = await emit(retry, "auth:login", { username: "seeduser0", password: server.password });
    assert.equal(next.ok, true);
    const expiredNext = new Promise(resolve => retry.once("auth:expired", resolve));
    const remaining = await emit(current, "auth:device-revoke", { others: true });
    assert.equal(remaining.ok, true);
    assert.equal(remaining.sessions.length, 1);
    assert.equal(remaining.sessions[0].current, true);
    await expiredNext;
    assert.equal((await emit(other, "auth:restore", { token: outsider.account.token })).ok, true);
    assert.equal((await emit(current, "auth:restore", { token: server.token })).ok, true);
  } finally { for (const socket of sockets) socket.disconnect(); await server.stop(); }
});
