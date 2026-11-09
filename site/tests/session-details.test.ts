import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionLocator, sessionDevice, sessionIp } from "../src/server/sessionDetails";

test("device recognition distinguishes desktop app, browsers, phones and tablets", () => {
  assert.deepEqual(sessionDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Electron/35.0"), { os: "Windows", browser: "Майко Desktop", device: "desktop" });
  assert.equal(sessionDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0").browser, "Microsoft Edge");
  assert.deepEqual(sessionDevice("Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36"), { os: "Android", browser: "Chrome", device: "mobile" });
  assert.equal(sessionDevice("Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Safari/537.36").device, "tablet");
  assert.equal(sessionDevice("Mozilla/5.0 (iPad; CPU OS 18_0) Version/18.0 Safari/604.1").device, "tablet");
  assert.equal(sessionDevice().device, "unknown");
  assert.equal(sessionIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(sessionIp("unknown/path?query"), "");
});

test("location lookup skips private addresses, caches and coalesces public lookups", async () => {
  let calls = 0;
  const locate = createSessionLocator((async (url: string) => {
    calls++;
    assert.match(url, /^https:\/\/ipwho\.is\/8\.8\.8\.8\?/);
    return Response.json({ success: true, city: "Москва", region: "Москва", country: "Россия" });
  }) as typeof fetch);
  for (const ip of ["127.0.0.1", "192.168.1.2", "::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(await locate(ip), "Локальная или частная сеть");
  }
  assert.equal(await locate("not-an-ip"), null);
  assert.equal(calls, 0);
  assert.deepEqual(await Promise.all([locate("8.8.8.8"), locate("8.8.8.8")]), ["Москва, Россия", "Москва, Россия"]);
  assert.equal(await locate("8.8.8.8"), "Москва, Россия");
  assert.equal(calls, 1);
});

test("location service failure does not break sign-in or invent a place", async () => {
  for (const request of [
    async () => { throw new Error("timeout"); },
    async () => new Response("rate limit", { status: 429 }),
    async () => Response.json({ success: false, city: "untrusted" }),
    async () => Response.json({ success: true, city: {} }),
  ]) assert.equal(await createSessionLocator(request as typeof fetch)("8.8.4.4"), null);
});
