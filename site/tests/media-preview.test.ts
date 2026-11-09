import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createMediaPreviewService, previewWithin } from "../src/server/mediaPreview";
import { pickGiphyPreviewUrl, pickGiphySendAsset } from "../src/lib/giphyMedia";
import { validMicroPreview } from "../src/lib/microPreview";
import { microPreviewWithin } from "../src/server/mediaMicroPreview";
import { encodeMediaMicroPreview } from "../src/server/mediaMicroPreview";

test("Micro-JPEG photos and video covers reuse versioned previews; GIFs never generate hashes", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-microPreview-"));
  try {
    const original = path.join(folder, "red.png");
    await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } }).png().toFile(original);
    let reads = 0;
    const service = createMediaPreviewService(path.join(folder, "thumbs"));
    const request = { name: "photo.png", version: "one", width: 430, source: async () => { reads++; return original; } };
    const hashes = await Promise.all(Array.from({ length: 8 }, () => service.microPreview(request)));
    const hash = hashes[0];
    assert.ok(hash);
    assert.equal(validMicroPreview(hash), hash);
    assert.ok(hash.length < 2048);
    assert.ok(hashes.every(value => value === hash));
    assert.equal(reads, 1);
    const rgba = await sharp(Buffer.from(hash.split(",")[1], "base64")).resize(1, 1).raw().toBuffer();
    assert.ok(rgba[0] > 240 && rgba[1] < 20 && rgba[2] < 20);
    assert.equal(await service.microPreview(request), hash);
    assert.equal(reads, 1);
    await sharp({ create: { width: 80, height: 40, channels: 3, background: "blue" } }).png().toFile(original);
    assert.notEqual(await service.microPreview({ ...request, version: "two" }), hash);
    assert.equal(reads, 2);
    const cover = await service.microPreview({ name: "video.webm", version: "one", width: 430,
      source: async () => path.resolve("e2e/fixtures/media-loading.webm") });
    assert.ok(validMicroPreview(cover));
    assert.equal(await service.microPreview({ ...request, name: "animation.GIF" }), undefined);
    assert.equal(reads, 2);
    assert.equal(await service.microPreview({ ...request, name: "broken.png", source: async () => "missing.png" }), undefined);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("micro-JPEG preserves aspect ratio, EXIF orientation and image regions", async () => {
  const photo = await sharp(Buffer.from('<svg width="160" height="80"><rect width="80" height="80" fill="red"/><rect x="80" width="80" height="80" fill="blue"/></svg>'))
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const preview = await encodeMediaMicroPreview(photo);
  assert.equal(validMicroPreview(preview), preview);
  const image = sharp(Buffer.from(preview.split(",")[1], "base64"));
  const metadata = await image.metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 16);
  assert.equal(metadata.height, 32);
  assert.equal(metadata.orientation, undefined);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const top = (4 * info.width + 8) * info.channels;
  const bottom = (27 * info.width + 8) * info.channels;
  assert.ok(data[top] > 200 && data[top + 2] < 50, "Red region stays at the top after orientation");
  assert.ok(data[bottom + 2] > 200 && data[bottom] < 50, "Blue region stays at the bottom");
});

test("malformed micro-previews are ignored and a history timeout leaves shared encoding running", async () => {
  for (const input of [undefined, null, 123, "", "???", "z".repeat(8193), "00!!!!", "😀".repeat(14), "data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64,bm90LWpwZWc="]) {
    assert.equal(validMicroPreview(input), undefined);
  }
  let finish!: (hash: string) => void;
  const job = new Promise<string>(resolve => { finish = resolve; });
  assert.equal(await microPreviewWithin(job, 1), undefined);
  finish("data:image/jpeg;base64,/9j/2wBDABcQERQRDhcUEhQaGBcbIjklIh8fIkYyNSk5UkhXVVFIUE5bZoNvW2F8Yk5QcptzfIeLkpSSWG2grJ+OqoOPko3/2wBDARgaGiIeIkMlJUONXlBejY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY3/wAARCAAQACADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAQX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwAAjUAAf//Z");
  assert.equal(await job, "data:image/jpeg;base64,/9j/2wBDABcQERQRDhcUEhQaGBcbIjklIh8fIkYyNSk5UkhXVVFIUE5bZoNvW2F8Yk5QcptzfIeLkpSSWG2grJ+OqoOPko3/2wBDARgaGiIeIkMlJUONXlBejY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY3/wAARCAAQACADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAQX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwAAjUAAf//Z");
});

test("photo previews preserve transparency, reduce bytes and reuse completed/versioned work", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-previews-"));
  try {
    const original = path.join(folder, "photo.png");
    await sharp({ create: { width: 1200, height: 800, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.3 } } })
      .png({ compressionLevel: 0 }).toFile(original);
    let reads = 0;
    const service = createMediaPreviewService(path.join(folder, "thumbs"));
    const request = { name: "photo.png", version: "one", width: 430, source: async () => { reads++; return original; } };
    const frames = await Promise.all(Array.from({ length: 8 }, () => service.get(request)));
    assert.ok(frames[0]);
    assert.ok(frames.every(frame => frame?.filename === frames[0]!.filename));
    assert.equal(reads, 1);
    assert.ok(frames[0].size < (await readFile(original)).length / 20);
    const metadata = await sharp(frames[0].filename).metadata();
    assert.equal(metadata.width, 430);
    assert.equal(metadata.hasAlpha, true);
    const { channels } = await sharp(frames[0].filename).stats();
    assert.ok(Math.abs(channels[3].mean - 0.3 * 255) <= 1);
    await service.get(request);
    assert.equal(reads, 1);
    const changed = await service.get({ ...request, version: "two" });
    assert.ok(changed);
    assert.notEqual(changed.filename, frames[0].filename);
    assert.equal(reads, 2);
    console.log(JSON.stringify({ originalBytes: (await readFile(original)).length, previewBytes: frames[0].size }));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("photo previews apply EXIF orientation, strip metadata and never enlarge small images", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-photo-orientation-"));
  try {
    const original = path.join(folder, "portrait.jpg");
    await sharp({ create: { width: 120, height: 240, channels: 3, background: "red" } })
      .withMetadata({ orientation: 6 }).jpeg().toFile(original);
    const service = createMediaPreviewService(path.join(folder, "thumbs"));
    const frame = await service.get({ name: "portrait.JPG", version: "one", width: 430, source: async () => original });
    assert.ok(frame);
    const metadata = await sharp(frame.filename).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 240);
    assert.equal(metadata.height, 120);
    assert.equal(metadata.orientation, undefined);
    assert.equal(metadata.exif, undefined);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("animated GIF and WebP previews contain only the first frame; AVIF is resized", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-photo-formats-"));
  try {
    const service = createMediaPreviewService(path.join(folder, "thumbs"));
    const pixels = Buffer.alloc(32 * 64 * 3);
    for (let i = 0; i < 32 * 32; i++) {
      pixels[i * 3] = 255;
      pixels[32 * 32 * 3 + i * 3 + 2] = 255;
    }
    for (const format of ["gif", "webp"] as const) {
      const original = path.join(folder, `animated.${format}`);
      await sharp(pixels, { raw: { width: 32, height: 64, channels: 3, pageHeight: 32 } })
        .toFormat(format, { delay: [100, 100], loop: 0 }).toFile(original);
      assert.equal((await sharp(original).metadata()).pages, 2);
      const frame = await service.get({ name: `animated.${format}`, version: "one", width: 430, source: async () => original });
      assert.ok(frame);
      const metadata = await sharp(frame.filename).metadata();
      assert.equal(metadata.width, 32);
      assert.equal(metadata.height, 32);
      assert.ok(!metadata.pages || metadata.pages === 1);
      const { channels } = await sharp(frame.filename).stats();
      assert.ok(channels[0].mean > 240 && channels[2].mean < 10);
    }
    const avif = path.join(folder, "photo.avif");
    await sharp({ create: { width: 640, height: 480, channels: 3, background: "blue" } }).avif().toFile(avif);
    const frame = await service.get({ name: "photo.avif", version: "one", width: 320, source: async () => avif });
    assert.ok(frame);
    assert.equal((await sharp(frame.filename).metadata()).width, 320);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("remote photos stream to a temporary file and clean up after success or failure", async t => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-remote-photo-"));
  try {
    const photo = await sharp({ create: { width: 640, height: 480, channels: 4, background: "#ff000080" } }).png().toBuffer();
    let reads = 0;
    const fetchMock = t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], options: RequestInit = {}) => {
      reads++;
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      if (String(url).endsWith("/large")) return new Response("", { headers: { "content-length": String(501 * 1024 * 1024) } });
      if (String(url).endsWith("/missing")) return new Response("missing", { status: 404 });
      if (String(url).endsWith("/corrupt")) return new Response("invalid image");
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(photo.subarray(0, 10)); controller.enqueue(photo.subarray(10)); controller.close(); },
      }));
    });
    const service = createMediaPreviewService(folder);
    const frame = await service.get({ name: "remote.png", version: "one", width: 430, source: async () => "https://storage.example/photo" });
    assert.ok(frame);
    assert.equal((await sharp(frame.filename).metadata()).width, 430);
    for (const suffix of ["large", "missing", "corrupt"]) {
      const request = { name: `${suffix}.png`, version: "one", width: 430, source: async () => `https://storage.example/${suffix}` };
      assert.equal(await service.get(request), null);
      assert.equal(await service.get(request), null); // Failures are briefly cached.
    }
    assert.equal(reads, 4);
    assert.deepEqual(await readdir(folder), [path.basename(frame.filename)]);
    fetchMock.mock.restore();
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("invalid photos leave no partial preview or source changes", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-invalid-photo-"));
  try {
    const original = path.join(folder, "broken.png");
    await writeFile(original, "not a photo");
    const thumbs = path.join(folder, "thumbs");
    const service = createMediaPreviewService(thumbs);
    assert.equal(await service.get({ name: "broken.png", version: "one", width: 430, source: async () => original }), null);
    assert.equal(await readFile(original, "utf8"), "not a photo");
    assert.deepEqual(await readdir(thumbs), []);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("a real video produces a small static cover without downloading the video in the UI", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-video-preview-"));
  try {
    const service = createMediaPreviewService(folder);
    const frame = await service.get({ name: "clip.webm", version: "one", width: 430,
      source: async () => path.resolve("e2e/fixtures/media-loading.webm") });
    assert.ok(frame);
    const bytes = await readFile(frame.filename);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
    assert.ok(bytes.length < 10_000);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("BMP previews retain the ffmpeg decoder fallback", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-bmp-preview-"));
  try {
    const original = path.join(folder, "photo.bmp");
    const bmp = Buffer.alloc(54 + 80 * 80 * 3);
    bmp.write("BM"); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(80, 18); bmp.writeInt32LE(80, 22);
    bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    for (let i = 54; i < bmp.length; i += 3) bmp[i + 1] = 255;
    await writeFile(original, bmp);
    const service = createMediaPreviewService(path.join(folder, "thumbs"));
    const frame = await service.get({ name: "photo.bmp", version: "one", width: 430, source: async () => original });
    assert.ok(frame);
    const metadata = await sharp(frame.filename).metadata();
    assert.equal(metadata.width, 80);
    assert.equal(metadata.height, 80);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("preview work is bounded and deduplicated; a timed-out consumer does not cancel shared work", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-preview-queue-"));
  const service = createMediaPreviewService(folder, { concurrency: 1, maxPending: 2 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const request = { name: "first.webm", version: "one", width: 430,
    source: async () => { reads++; await gate; return path.resolve("e2e/fixtures/media-loading.webm"); } };
  try {
    const first = service.get(request);
    const shared = service.get(request);
    await new Promise(resolve => setTimeout(resolve, 20));
    const queued = service.get({ ...request, name: "second.webm" });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await service.get({ ...request, name: "third.webm" }), null);
    assert.equal(await previewWithin(first, 10), null);
    assert.equal(reads, 1);
    release();
    const result = await Promise.all([first, shared, queued]);
    assert.ok(result.every(Boolean));
    assert.equal(reads, 2);
    assert.equal(result[0]?.filename, result[1]?.filename);
  } finally { release(); await rm(folder, { recursive: true, force: true }); }
});

test("GIF sending and picker use compact animated renditions before originals", () => {
  const images = {
    original: { webp: "https://media.giphy.com/media/test/original.webp", webp_size: "9000000" },
    fixed_width: { webp: "https://media.giphy.com/media/test/200.webp", webp_size: "80000" },
    fixed_width_downsampled: { webp: "https://media.giphy.com/media/test/200_d.webp", webp_size: "12000" },
  };
  assert.equal(pickGiphySendAsset(images)?.size, 80000);
  assert.equal(pickGiphyPreviewUrl(images), images.fixed_width_downsampled.webp);
  assert.ok(pickGiphySendAsset({ original: images.original }));
});
