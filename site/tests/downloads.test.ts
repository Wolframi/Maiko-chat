import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { downloadHref } from "../src/lib/files";
import { downloadName, downloadDisposition } from "../src/server/downloadName";

test("download links keep authorization and the original name and request full media", () => {
  const url = new URL(downloadHref("/uploads/key.pdf?exp=123&sig=signature&w=430&waveform=1#preview", "Отчёт (октябрь).pdf"), "http://localhost");
  assert.equal(url.searchParams.get("exp"), "123");
  assert.equal(url.searchParams.get("sig"), "signature");
  assert.equal(url.searchParams.get("name"), "Отчёт (октябрь).pdf");
  assert.equal(url.searchParams.get("download"), "1");
  assert.equal(url.searchParams.has("w"), false);
  assert.equal(url.searchParams.has("waveform"), false);
  assert.equal(url.hash, "");
  assert.equal(downloadHref("blob:http://localhost/test", "Фото.png"), "blob:http://localhost/test");
  assert.equal(new URL(downloadHref("/uploads/key.pdf", "12345678-1234-1234-1234-123456789abc_Отчёт.pdf"), "http://localhost").searchParams.get("name"), "Отчёт.pdf");
});

test("response names handle Unicode, header delimiters and path traversal", () => {
  assert.equal(downloadName("../../Отчёт.pdf", "file.pdf"), "Отчёт.pdf");
  assert.equal(downloadName('Отчёт\r\n".pdf', "file.pdf"), "Отчёт___.pdf");
  assert.equal(downloadName("..", "file.pdf"), "file.pdf");
  const disposition = downloadDisposition("Отчёт (1)'s.pdf", true);
  assert.ok(disposition.startsWith('attachment; filename="'));
  assert.ok(disposition.includes("filename*=UTF-8''"));
  assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), "Отчёт (1)'s.pdf");
  assert.match(disposition, /%27s/);
});

test("real upload responses keep filenames, bytes and signatures, including range and HEAD", async () => {
  const cwd = process.cwd();
  const temporary = await mkdtemp(path.join(tmpdir(), "maiko-download-server-"));
  const mediaStorage = process.env.MEDIA_STORAGE;
  const signingSecret = process.env.UPLOAD_SIGNING_SECRET;
  process.env.MEDIA_STORAGE = "local";
  process.env.UPLOAD_SIGNING_SECRET = "isolated-download-test";
  process.chdir(temporary);
  const { tryServeUpload, signUploadUrl } = await import("../src/server/uploads");
  const server = createServer((req, res) => { if (!tryServeUpload(req, res)) { res.statusCode = 404; res.end(); } });
  try {
    await mkdir(path.join(temporary, "uploads"), { recursive: true });
    const stored = "/uploads/12345678-1234-1234-1234-123456789abc.pdf";
    const bytes = Buffer.from("%PDF-1.4\noriginal download bytes\n");
    await writeFile(path.join(temporary, stored), bytes);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const href = origin + downloadHref(signUploadUrl(stored), "Отчёт за октябрь.pdf");
    const response = await fetch(href);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const disposition = response.headers.get("content-disposition")!;
    assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), "Отчёт за октябрь.pdf");
    const head = await fetch(href, { method: "HEAD" });
    assert.equal(head.headers.get("content-disposition"), disposition);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    const cached = await fetch(href, { headers: { "if-none-match": response.headers.get("etag")! } });
    assert.equal(cached.status, 200, "An explicit download must return bytes instead of 304");
    const range = await fetch(href, { headers: { range: "bytes=0-7" } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8));
    assert.equal((await fetch(origin + downloadHref(stored, "Отчёт.pdf"))).status, 403, "A suggested filename never bypasses authorization");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.chdir(cwd);
    if (mediaStorage === undefined) delete process.env.MEDIA_STORAGE; else process.env.MEDIA_STORAGE = mediaStorage;
    if (signingSecret === undefined) delete process.env.UPLOAD_SIGNING_SECRET; else process.env.UPLOAD_SIGNING_SECRET = signingSecret;
    await rm(temporary, { recursive: true, force: true });
  }
});
