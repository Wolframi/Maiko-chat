import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, createECDH, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { lookup } from "node:dns";
import type { Socket } from "socket.io";
import { isAllowedPushEndpoint, isPublicPushAddress, validPushKeys, createPushLookup } from "../src/server/pushSecurity";
import { issueTurnCredentials, TURN_TTL_SECONDS } from "../src/server/turnCredentials";
import { rateLimit } from "../src/server/rateLimit";
import { MessageAdmission } from "../src/server/messageAdmission";
import { monitorSocketBackpressure, isSocketBackedUp } from "../src/server/socketBackpressure";
import { gifParameters, createGifService } from "../src/server/gif";
import { MessageStore } from "../src/server/messageStore";
import { clientAddress, allowRegistration } from "../src/server/requestSecurity";
import type { IncomingMessage } from "node:http";
import { clearClientIceCache, getClientIceServers } from "../src/lib/iceServers";
import { avatarDisplaySrc } from "../src/lib/avatar";
import { signedMediaSrc } from "../src/lib/files";

test("push endpoints reject arbitrary HTTPS hosts, local addresses, credentials and ports", () => {
  for (const url of ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/", "https://evil.test/", "https://fcm.googleapis.com.evil.test/", "https://evil@fcm.googleapis.com/", "https://fcm.googleapis.com:444/x", "https://web.push.apple.com/#x"]) {
    assert.equal(isAllowedPushEndpoint(url), false, url);
  }
  for (const url of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-bl2p.notify.windows.com/w/?token=x"]) assert.equal(isAllowedPushEndpoint(url), true, url);
  for (const ip of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.100.100.200", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "2002:7f00:1::", "2001:db8::1"]) assert.equal(isPublicPushAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPublicPushAddress(ip), true, ip);
  assert.equal(validPushKeys({ p256dh: createECDH("prime256v1").generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") }), true);
  assert.equal(validPushKeys({ p256dh: "x", auth: "x" }), false);
});

test("push connection DNS rejects rebinding and mixed public/private answers", async () => {
  for (const addresses of [[{ address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }]]) {
    const resolve = ((_host: string, _opts: unknown, cb: (error: null, result: typeof addresses) => void) => cb(null, addresses)) as unknown as typeof lookup;
    await new Promise<void>(done => createPushLookup(resolve)("fcm.googleapis.com", {}, error => { assert.ok(error); done(); }));
  }
  const resolve = ((_host: string, _opts: unknown, cb: (error: null, result: { address: string; family: number }[]) => void) => cb(null, [{ address: "8.8.8.8", family: 4 }])) as unknown as typeof lookup;
  await new Promise<void>(done => createPushLookup(resolve)("fcm.googleapis.com", {}, (error, address) => { assert.equal(error, null); assert.equal(address, "8.8.8.8"); done(); }));
});

test("TURN credentials expire and differ for each user, session and issuance", () => {
  const secret = "a".repeat(64), now = 1700000000000;
  const first = issueTurnCredentials(secret, "user1", "session1", now);
  assert.equal(first.expiresAt, Math.floor(now / 1000) + TURN_TTL_SECONDS);
  assert.ok(first.username.startsWith(first.expiresAt + ":"));
  assert.equal(first.credential, createHmac("sha1", secret).update(first.username).digest("base64"));
  for (const other of [issueTurnCredentials(secret, "user1", "session1", now), issueTurnCredentials(secret, "user1", "session2", now), issueTurnCredentials(secret, "user2", "session1", now)]) assert.notEqual(other.username, first.username);
  assert.throws(() => issueTurnCredentials("short", "u", "s"));
});

test("weighted rate limit and message admission bound bursts and pending work", () => {
  const key = randomBytes(10).toString("hex");
  assert.equal(rateLimit(key, 10, 60000, 8), true);
  assert.equal(rateLimit(key, 10, 60000, 3), false);
  const admission = new MessageAdmission();
  const release = admission.acquire("security-user", "security-room", 1)!;
  assert.ok(release);
  const second = admission.acquire("security-user", "security-room", 1)!;
  assert.equal(admission.acquire("security-user", "security-room", 1), null);
  release(); release(); second();
  assert.equal(admission.sample().pending, 0);
  let accepted = 0;
  for (let i = 0; i < 30; i++) { const done = admission.acquire("burst-user", "burst-room", 1); if (done) { accepted++; done(); } }
  assert.equal(accepted, 5);
});

test("backpressure disconnects slow consumers and drain resets the bound", () => {
  const fake = new EventEmitter() as EventEmitter & { conn: EventEmitter; disconnect: () => void };
  fake.conn = new EventEmitter();
  let disconnected = 0;
  fake.disconnect = () => { disconnected++; fake.emit("disconnect"); };
  const socket = fake as unknown as Socket;
  monitorSocketBackpressure(socket);
  for (let i = 0; i < 40; i++) fake.conn.emit("packetCreate", { data: "test" });
  assert.equal(isSocketBackedUp(socket), true);
  fake.conn.emit("drain");
  assert.equal(isSocketBackedUp(socket), false);
  for (let i = 0; i < 65; i++) fake.conn.emit("packetCreate", { data: "test" });
  assert.equal(disconnected, 1);
});

test("GIF requests validate input and coalesce upstream requests", async () => {
  for (const query of ["?limit=-1", "?limit=1000000", "?pos=Infinity", "?pos=-5", "?q=" + "x".repeat(101)]) assert.equal(gifParameters("/api/gif" + query), null);
  let calls = 0;
  const service = createGifService(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ data: [], pagination: { total_count: 0 } });
  }, () => "test-key");
  const responses = await Promise.all(Array.from({ length: 10 }, () => service("/api/gif?q=security-test")));
  assert.equal(calls, 1);
  assert.ok(responses.every(r => r.status === 200));
  assert.equal((await service("/api/gif?q=security-test")).status, 200);
  assert.equal(calls, 1);
});

test("MongoDB writer batches a burst while preserving the latest mutation", async () => {
  const store = new MessageStore<{ id: string; room: string; createdAt: number; text: string }>("mongodb://127.0.0.1:1", "security_test");
  const internals = store as unknown as { collection: { bulkWrite: (ops: unknown[]) => Promise<void> } };
  // Isolate batching from the derived-summary writer, which has real MongoDB tests.
  (store as unknown as { summaries: unknown }).summaries = {
    writeBatch: async (_ops: unknown[], write: () => Promise<unknown>) => write(),
    idle: async () => undefined,
  };
  let calls = 0;
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const written: unknown[][] = [];
  internals.collection.bulkWrite = async ops => { calls++; written.push(ops); if (calls === 1) await blocked; };
  const message = { id: "m", room: "r", createdAt: 1, text: "first" };
  store.append(message);
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 100; i++) { message.text = "latest-" + i; store.update(message); }
  unblock();
  await store.idle();
  assert.equal(calls, 2);
  assert.match(JSON.stringify(written[1]), /latest-99/);
  await store.close();
});

test("registration limits survive reconnects; forwarded IP is trusted only from loopback", () => {
  for (let i = 0; i < 3; i++) assert.equal(allowRegistration("registration-test"), true);
  assert.equal(allowRegistration("registration-test"), false);
  const old = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "1";
  try {
    const req = { socket: { remoteAddress: "203.0.113.4" }, headers: { "x-real-ip": "8.8.8.8", "x-forwarded-for": "8.8.4.4" } } as unknown as IncomingMessage;
    assert.equal(clientAddress(req), "203.0.113.4");
  } finally { if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old; }
});

test("media rendering and avatar retries retain exp and sig", () => {
  const signed = "/uploads/photo.png?exp=1234567890000&sig=test-signature";
  const avatar = new URL(avatarDisplaySrc(signedMediaSrc(signed), 2), "http://localhost");
  assert.equal(avatar.searchParams.get("exp"), "1234567890000");
  assert.equal(avatar.searchParams.get("sig"), "test-signature");
  assert.equal(avatar.searchParams.get("retry"), "2");
});

test("an ICE request completing after account switch cannot overwrite another session's cache", async t => {
  clearClientIceCache();
  let finishFirst!: (response: Response) => void;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    const token = (init.headers as Record<string, string>)["x-pulse-token"];
    if (token === "old-session") return await new Promise<Response>(resolve => { finishFirst = resolve; });
    return Response.json({ iceServers: [{ urls: "turn:relay.example.com", username: "new-session", credential: "new" }] });
  });
  const first = getClientIceServers("old-session");
  assert.equal((await getClientIceServers("new-session"))[0].username, "new-session");
  finishFirst(Response.json({ iceServers: [{ urls: "turn:relay.example.com", username: "old-session", credential: "old" }] }));
  await first;
  assert.equal((await getClientIceServers("new-session"))[0].username, "new-session");
  assert.equal(calls, 2);
  clearClientIceCache();
});
