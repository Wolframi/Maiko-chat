/** Real S3 integration check. Requires S3_CONFIG_FILE; all objects use a unique test prefix. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

async function main() {
  if (!process.env.S3_CONFIG_FILE) throw new Error("Set S3_CONFIG_FILE explicitly for this integration test");
  process.env.S3_CONFIG_FILE = path.resolve(process.env.S3_CONFIG_FILE);
  process.env.MEDIA_STORAGE = "s3";
  process.env.S3_PREFIX = `integration-tests/${randomUUID()}`;
  const originalCwd = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), "pulse-s3-test-"));
  process.chdir(dir);
  const storage = await import("../src/server/objectStorage");
  const uploads = await import("../src/server/uploads");
  const auth = await import("../src/server/auth");
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/upload")) uploads.handleUpload(req, res);
    else if (!uploads.tryServeUpload(req, res)) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const account = auth.registerUser("s3_test", randomUUID());
  assert(account.ok);
  async function upload(name: string, body: Buffer, type: string, kind = "") {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(body)], { type }), name);
    return fetch(`${origin}/api/upload${kind ? `?kind=${kind}` : ""}`, {
      method: "POST", body: form,
      headers: { origin, "x-pulse-token": account.ok ? account.account.token || "" : "" },
    });
  }
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSAAAAAASUVORK5CYII=", "base64");
    const response = await upload("avatar.png", png, "image/png", "avatar");
    assert.equal(response.status, 200);
    const { file } = await response.json() as { file: { url: string } };
    assert(await uploads.isValidStoredAvatar(file.url));
    const info = await uploads.getUploadInfo(file.url);
    assert.equal(info?.size, png.length);
    assert(!existsSync(path.join(dir, "uploads", info!.fileName)), "upload must not depend on a local original");
    const image = await fetch(`${origin}${file.url}`);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const head = await fetch(`${origin}${file.url}`, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), String(png.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const conditional = await fetch(`${origin}${file.url}`, { headers: { "if-none-match": head.headers.get("etag")! } });
    assert.equal(conditional.status, 304);
    for (const [range, expected] of [["bytes=0-7", png.subarray(0, 8)], ["bytes=-5", png.subarray(-5)]] as const) {
      const partial = await fetch(`${origin}${file.url}`, { headers: { range } });
      assert.equal(partial.status, 206);
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected);
    }
    const invalidRange = await fetch(`${origin}${file.url}`, { headers: { range: "bytes=99999-" } });
    assert.equal(invalidRange.status, 416);
    await uploads.withUploadFile(file.url, (filename) => assert(existsSync(filename)));
    assert.equal(readdirSync(path.join(dir, "data", "media-tmp")).length, 0);

    const jpegPath = path.join(dir, "test.jpg");
    const jpegResult = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080,noise=alls=30:allf=t", "-frames:v", "1", "-q:v", "2", jpegPath], { windowsHide: true });
    assert.equal(jpegResult.status, 0, "ffmpeg is required for thumbnail integration checks");
    const jpeg = readFileSync(jpegPath);
    assert(jpeg.length > 120_000);
    const photoResponse = await upload("photo.jpg", jpeg, "image/jpeg");
    assert.equal(photoResponse.status, 200);
    const photo = await photoResponse.json() as { file: { url: string } };
    const thumb = await fetch(`${origin}${photo.file.url}&w=320`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get("content-type"), "image/jpeg");
    const thumbBytes = Buffer.from(await thumb.arrayBuffer());
    assert(thumbBytes.length > 0 && thumbBytes.length < jpeg.length);
    const thumbHead = await fetch(`${origin}${photo.file.url}&w=320`, { method: "HEAD" });
    assert.equal(Number(thumbHead.headers.get("content-length")), thumbBytes.length);
    assert.equal(readdirSync(path.join(dir, "uploads", "thumbs")).length, 0);

    const videoPath = path.join(dir, "test.mov");
    const videoResult = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "0.3", "-c:v", "mpeg4", videoPath], { windowsHide: true });
    assert.equal(videoResult.status, 0);
    const movieResponse = await upload("movie.mov", readFileSync(videoPath), "video/quicktime");
    assert.equal(movieResponse.status, 200);
    const movie = await movieResponse.json() as { file: { url: string } };
    assert.match(uploads.bareUploadUrl(movie.file.url), /\.mp4$/);
    const movieName = uploads.uploadNameFromUrl(movie.file.url)!;
    for (let i = 0; i < 100 && existsSync(path.join(dir, "uploads", movieName)); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert(!existsSync(path.join(dir, "uploads", movieName)), "video must be cleaned after background conversion");
    await uploads.withUploadFile(movie.file.url, (filename) => {
      const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", filename], { encoding: "utf8", windowsHide: true });
      assert.equal(probe.stdout.trim(), "h264");
    });

    const pdf = Buffer.from("%PDF-1.4\nS3 integration test document\n");
    const document = await upload("document.pdf", pdf, "application/pdf");
    assert.equal(document.status, 200);
    const doc = await document.json() as { file: { url: string } };
    assert.equal((await fetch(`${origin}${uploads.bareUploadUrl(doc.file.url)}`)).status, 403);
    const download = await fetch(`${origin}${doc.file.url}&download=1`);
    assert.match(download.headers.get("content-disposition") || "", /^attachment/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
    assert.equal((await upload("fake.png", Buffer.from("not an image"), "image/png", "avatar")).status, 400);
    assert.equal((await upload("bad.html", Buffer.from("<script/>"), "text/html")).status, 400);
    for (const bad of ["/uploads/%2e%2e%2fdata%2fusers.json", "/uploads/%5cdata", "/uploads/%ZZ", `/uploads/${randomUUID()}.png`]) {
      assert.equal((await fetch(`${origin}${bad}`)).status, 404);
    }
    assert.equal((await fetch(`${origin}${file.url}`, { method: "POST" })).status, 405);

    type DirectStart = { ok: boolean; id: string; parts: Array<{ partNumber: number; size: number; url: string }>; error?: string };
    const s3Fetch = process.env.S3_LOCAL_ADDRESS
      ? await (async () => {
        const undici = await import("undici");
        const dispatcher = new undici.Agent({ connect: { localAddress: process.env.S3_LOCAL_ADDRESS } });
        return ((url: string, init?: Parameters<typeof undici.fetch>[1]) => undici.fetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
      })()
      : fetch;
    async function directCall(action: string, body: Record<string, unknown>) {
      return fetch(`${origin}/api/upload/direct/${action}`, {
        method: "POST", body: JSON.stringify(body),
        headers: { origin, "content-type": "application/json", "x-pulse-token": account.ok ? account.account.token || "" : "" },
      });
    }
    async function directUpload(name: string, body: Buffer, type: string) {
      const start = await directCall("start", { name, size: body.length, type });
      assert.equal(start.status, 200);
      const ticket = await start.json() as DirectStart;
      let offset = 0;
      const parts = [];
      for (const part of ticket.parts) {
        const put = await s3Fetch(part.url, { method: "PUT", body: new Uint8Array(body.subarray(offset, offset + part.size)) });
        assert.equal(put.status, 200);
        parts.push({ partNumber: part.partNumber, etag: put.headers.get("etag") });
        offset += part.size;
      }
      return directCall("complete", { id: ticket.id, parts });
    }

    const directPdf = await directUpload("отчёт.pdf", pdf, "application/pdf");
    assert.equal(directPdf.status, 200);
    const directDoc = await directPdf.json() as { file: { url: string; name: string; mime: string; size: number } };
    assert.equal(directDoc.file.name, "отчёт.pdf");
    assert.equal(directDoc.file.mime, "application/pdf");
    assert.deepEqual(Buffer.from(await (await fetch(`${origin}${directDoc.file.url}&download=1`)).arrayBuffer()), pdf);
    assert(!existsSync(path.join(dir, "uploads", uploads.uploadNameFromUrl(directDoc.file.url)!)));

    const big = Buffer.from(randomUUID().repeat(Math.ceil((17 * 1024 * 1024) / 36)).slice(0, 17 * 1024 * 1024 + 123));
    const bigStart = await directCall("start", { name: "archive.zip", size: big.length, type: "application/zip" });
    const bigTicket = await bigStart.json() as DirectStart;
    assert.equal(bigTicket.parts.length, 2);
    const wrongSize = await s3Fetch(bigTicket.parts[0].url, { method: "PUT", body: new Uint8Array(big.subarray(0, 1024)) });
    assert.equal(wrongSize.status, 403, "part URL must pin its exact size");
    assert.equal((await directCall("abort", { id: bigTicket.id })).status, 200);
    assert.equal((await directCall("complete", { id: bigTicket.id, parts: [] })).status, 404);
    const bigResponse = await directUpload("archive.zip", big, "application/zip");
    assert.equal(bigResponse.status, 200);
    const bigFile = await bigResponse.json() as { file: { url: string } };
    assert.equal((await uploads.getUploadInfo(bigFile.file.url))?.size, big.length);
    const tail = await fetch(`${origin}${bigFile.file.url}&download=1`, { headers: { range: `bytes=${big.length - 64}-` } });
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), big.subarray(-64));

    const fakeImage = await directUpload("fake.jpg", Buffer.from("definitely not a jpeg"), "image/jpeg");
    assert.equal(fakeImage.status, 400);
    const directPhoto = await directUpload("photo.jpg", jpeg, "image/jpeg");
    assert.equal(directPhoto.status, 200);
    const directPhotoFile = await directPhoto.json() as { file: { url: string } };
    assert.equal((await uploads.getUploadInfo(directPhotoFile.file.url))?.image, true);
    assert.equal((await fetch(`${origin}${uploads.bareUploadUrl(directPhotoFile.file.url)}`)).status, 200);
    assert.equal((await directCall("start", { name: "bad.html", size: 10, type: "text/html" })).status, 400);
    assert.equal((await directCall("start", { name: "huge.zip", size: 600 * 1024 * 1024, type: "application/zip" })).status, 413);

    const directMovie = await directUpload("clip.mov", readFileSync(videoPath), "video/quicktime");
    assert.equal(directMovie.status, 200);
    const directMovieFile = await directMovie.json() as { file: { url: string; mime: string } };
    assert.match(uploads.bareUploadUrl(directMovieFile.file.url), /\.mp4$/);
    assert.equal(directMovieFile.file.mime, "video/mp4");
    let codec = "";
    for (let i = 0; i < 100 && codec !== "h264"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      codec = await uploads.withUploadFile(directMovieFile.file.url, (filename) =>
        spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", filename], { encoding: "utf8", windowsHide: true }).stdout.trim());
    }
    assert.equal(codec, "h264", "direct video upload must be converted in the background");

    if (process.env.S3_CORS_ORIGIN) {
      const preflight = await s3Fetch(bigTicket.parts[0].url, {
        method: "OPTIONS",
        headers: { origin: process.env.S3_CORS_ORIGIN, "access-control-request-method": "PUT" },
      });
      assert.equal(preflight.headers.get("access-control-allow-origin"), process.env.S3_CORS_ORIGIN);
    }

    const audio = Buffer.from("test ringtone bytes");
    await storage.putObjectBuffer("ringtones/audio/check.mp3", audio, "audio/mpeg");
    assert.deepEqual(await storage.readObjectBuffer("ringtones/audio/check.mp3"), audio);
    // A simulated PUT failure must never acknowledge an upload as successful.
    storage.s3Client!.middlewareStack.add(() => async () => { throw new Error("simulated S3 outage"); }, { step: "initialize", name: "testFailure" });
    try {
      const failed = await upload("failed.png", png, "image/png");
      assert.notEqual(failed.status, 200);
      assert.equal((await failed.json() as { ok: boolean }).ok, false);
    } finally { storage.s3Client!.middlewareStack.remove("testFailure"); }
    assert.equal(readdirSync(path.join(dir, "uploads")).filter((name) => name !== "thumbs").length, 0);
    for (let i = 0; i < 50 && readdirSync(path.join(dir, "data", "media-tmp")).length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(readdirSync(path.join(dir, "data", "media-tmp")).length, 0);
    console.log("PASS: S3 upload/read, direct browser uploads (multipart, exact-size parts, abort, image check, video conversion), avatars, thumbnails, background video conversion, HEAD, ETag, ranges, private documents, invalid uploads/paths, temporary cleanup, ringtone buffers, S3 failure handling");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const location = storage.objectLocation("cleanup");
    const prefix = location.Key.slice(0, -"cleanup".length);
    const objects = await storage.s3Client!.send(new ListObjectsV2Command({ Bucket: location.Bucket, Prefix: prefix }));
    for (const object of objects.Contents || []) {
      assert(object.Key?.startsWith(prefix));
      await storage.s3Client!.send(new DeleteObjectCommand({ Bucket: location.Bucket, Key: object.Key }));
    }
    storage.s3Client!.destroy();
    process.chdir(originalCwd);
    // Only the freshly generated test directory is removed.
    assert(path.dirname(dir) === path.resolve(tmpdir()) && path.basename(dir).startsWith("pulse-s3-test-"));
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) {
      if (process.platform !== "win32") throw error;
      console.warn(`Windows loader still holds temporary directory: ${dir}`);
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
