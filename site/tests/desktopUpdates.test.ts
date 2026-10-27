import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createDesktopUpdateHandler } from "../src/server/desktopUpdates";

test("private desktop feed serves metadata and redirects artifact bytes, allowing only release filenames", async () => {
  const requests: string[] = [];
  const handler = createDesktopUpdateHandler({
    manifest: async () => Buffer.from("version: 1.1.14\n"),
    download: async (name) => {
      requests.push(name);
      if (name.includes("0.0.0")) throw { $metadata: { httpStatusCode: 404 } };
      return { url: `https://s3.example.test/maiko/desktop-updates/${name}?signature=temporary`, size: 100 };
    },
  });
  const server = createServer((req, res) => { if (!handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const manifest = await fetch(origin + "/desktop-updates-s3/latest.yml?noCache=123");
    assert.equal(await manifest.text(), "version: 1.1.14\n");
    assert.equal(manifest.headers.get("cache-control"), "no-store");
    const file = await fetch(origin + "/desktop-updates-s3/Maiko-Setup-1.1.14.exe", { redirect: "manual", headers: { Range: "bytes=0-31" } });
    assert.equal(file.status, 302);
    assert.match(file.headers.get("location")!, /^https:\/\/s3\.example\.test\/maiko\/desktop-updates\/Maiko-Setup-1\.1\.14\.exe/);
    assert.equal(await file.text(), "", "The server never streams installer bytes");
    const head = await fetch(origin + "/desktop-updates-s3/Maiko-Setup-1.1.13.exe.blockmap", { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "100");
    for (const name of [".desktop-s3-storage.json", "uploads/private.pdf", "%2e%2e%2fsecret", "Maiko-Setup-1.1.14.exe/extra"]) {
      assert.equal((await fetch(origin + "/desktop-updates-s3/" + name)).status, 404);
    }
    assert.deepEqual(requests, ["Maiko-Setup-1.1.14.exe", "Maiko-Setup-1.1.13.exe.blockmap"]);
    assert.equal((await fetch(origin + "/desktop-updates-s3/latest.yml", { method: "POST" })).status, 405);
    assert.equal((await fetch(origin + "/desktop-updates-s3/Maiko-Setup-0.0.0.exe")).status, 404);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("missing S3 configuration fails explicitly without serving local artifacts", async () => {
  const handler = createDesktopUpdateHandler(null);
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/desktop-updates-s3/latest.yml`);
    assert.equal(response.status, 503);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Windows download resolves the current published installer on every request", async () => {
  let metadata = "version: 1.1.17\n";
  const requests: string[] = [];
  const handler = createDesktopUpdateHandler({
    manifest: async () => Buffer.from(metadata),
    download: async (name) => {
      requests.push(name);
      return { url: `https://s3.example.test/${name}`, size: 100 };
    },
  });
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/desktop-updates-s3/latest.exe`;
  try {
    const first = await fetch(url, { redirect: "manual" });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), "https://s3.example.test/Maiko-Setup-1.1.17.exe");
    assert.equal(first.headers.get("cache-control"), "no-store");

    metadata = "version: 1.1.18\n";
    const next = await fetch(url, { redirect: "manual" });
    assert.equal(next.headers.get("location"), "https://s3.example.test/Maiko-Setup-1.1.18.exe");
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "100");
    assert.equal(await head.text(), "");
    assert.equal((await fetch(url, { method: "POST" })).status, 405);

    for (metadata of ["", "version: ../../private\n", "version: 1.1.18-beta\n"]) {
      assert.equal((await fetch(url)).status, 503);
    }
    assert.deepEqual(requests, ["Maiko-Setup-1.1.17.exe", "Maiko-Setup-1.1.18.exe", "Maiko-Setup-1.1.18.exe"]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
