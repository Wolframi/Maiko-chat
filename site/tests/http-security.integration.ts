import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { io } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";

test("production HTTP and Socket.IO enforce security without restarting or breaking valid messages", { timeout: 90000 }, async () => {
  const server = await securityServer();
  const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false });
  const request = (pathname: string, options: RequestInit = {}) => fetch(server.base + pathname, { ...options, headers: { "x-pulse-token": server.token, ...options.headers }, signal: AbortSignal.timeout(10000) });
  const emit = (event: string, payload: unknown) => socket.timeout(10000).emitWithAck(event, payload) as Promise<Record<string, any>>;
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    assert.deepEqual(await emit("chats:pin", { chatId: "security-group-0" }), { ok: false, error: "Сначала войдите" });
    assert.equal((await emit("auth:restore", { token: server.token })).ok, true);
    assert.equal((await emit("chats:pin", { chatId: "security-group-1" })).ok, false);
    assert.equal((await emit("chats:pin", { chatId: "security-group-0" })).ok, true);
    for (let i = 0; i < 8; i++) assert.equal((await emit("auth:login", { username: "seeduser0", password: "WrongPassword!" })).ok, false);
    assert.match(String((await emit("auth:login", { username: "seeduser0", password: server.password })).error), /много попыток/);
    // A login attack must not consume session restoration or registration quotas.
    assert.equal((await emit("auth:restore", { token: server.token })).ok, true);
    for (let i = 0; i < 12; i++) assert.equal((await emit("auth:register", {})).error, "Введите логин и пароль");
    const health = await (await fetch(server.base + "/api/health")).json();
    assert.deepEqual(health, { ok: true, desktopMediaHost: 1 });
    const privateHealth = await (await request("/api/health")).json();
    assert.equal(typeof privateHealth.buildId, "string");
    assert.equal(privateHealth.bootId, undefined);
    assert.equal((await fetch(server.base + "/api/gif")).status, 401);
    assert.equal((await request("/api/gif?limit=-1")).status, 400);
    assert.equal((await fetch(server.base + "/api/ice")).status, 401);
    const first = await (await request("/api/ice")).json();
    const second = await (await request("/api/ice")).json();
    const turn = first.iceServers.find((s: { username?: string }) => s.username);
    assert.ok(turn);
    assert.equal(turn.credential, createHmac("sha1", server.secret).update(turn.username).digest("base64"));
    assert.notEqual(second.iceServers.find((s: { username?: string }) => s.username).username, turn.username);
    for (const endpoint of ["http://127.0.0.1:3000/api/health", "https://169.254.169.254/latest/meta-data", "https://evil.example/", "https://fcm.googleapis.com.evil.example/", "https://fcm.googleapis.com/send"]) {
      const response = await request("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: "bad", auth: "bad" } } }) });
      assert.equal(response.status, 400, endpoint);
    }
    assert.equal((await request("/api/push/subscribe", { method: "POST", body: "x".repeat(9000) })).status, 413);
    const privateGroup = await emit("group:create", { title: "Hidden directory fixture", visibility: "private" });
    assert.equal(privateGroup.ok, true);
    const publicGroups = (await emit("groups:search", { query: " " })).groups;
    assert.equal(publicGroups.length, 30);
    assert.ok(publicGroups.every((group: { id: string }) => /^security-group-\d+$/.test(group.id) || group.id === "oversized"));
    assert.deepEqual((await emit("groups:search", { query: "Hidden directory fixture" })).groups, []);
    assert.deepEqual((await emit("groups:search", { query: "s" })).groups, []);
    assert.ok((await emit("groups:search", { query: "seed" })).groups.length <= 30);
    const suggested = (await emit("people:suggest", {})).users;
    assert.ok(suggested.length <= 12);
    assert.ok(suggested.every((u: { id: string }) => u.id === "security-user-1"));
    const users = (await emit("people:suggest", { query: "seed" })).users;
    assert.equal(users.length, 20);
    assert.ok(users.every((u: Record<string, unknown>) => u.id !== "security-user-0" && !("bio" in u) && !("lastSeenAt" in u) && !("online" in u)));
    assert.equal((await emit("group:join", { groupId: "security-group-0" })).ok, true);
    const sent = await emit("message", { chatId: "security-group-0", text: "valid signed-in message", clientId: "valid-message" });
    assert.equal(sent.ok, true);
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => emit("message", { chatId: "security-group-0", text: "burst-" + i, clientId: "burst-" + i })));
    assert.ok(burst.some(result => !result.ok));
    assert.ok(burst.filter(result => result.ok).length <= 4);
    assert.equal((await emit("group:join", { groupId: "oversized" })).ok, true);
    assert.equal((await emit("message", { chatId: "oversized", text: "must reject" })).ok, false);
    for (let i = 0; i < 4; i++) {
      const result = await emit("auth:register", { username: "securityregister" + i, password: "SecurityFixture123!" });
      assert.equal(result.ok, i < 3);
    }
    assert.equal((await request("/api/health")).status, 200);
    assert.equal((await (await request("/api/health")).json()).buildId, privateHealth.buildId);
    const page = await fetch(server.base);
    const csp = page.headers.get("content-security-policy")!;
    const scriptPolicy = csp.split(";").find(p => p.trim().startsWith("script-src"))!;
    assert.ok(!scriptPolicy.includes("'unsafe-inline'") && !scriptPolicy.includes("'unsafe-eval'"));
    const nonce = /'nonce-([^']+)'/.exec(scriptPolicy)![1];
    const html = await page.text();
    assert.equal(page.status, 200);
    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(m => m[2]);
    assert.ok(inlineScripts.length > 0);
    assert.ok(inlineScripts.every(m => m[1].includes(`nonce="${nonce}"`)));
  } finally { socket.disconnect(); await server.stop(); }
});
