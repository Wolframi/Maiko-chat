import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMediaPreviewService, previewWithin } from "../src/server/mediaPreview";
import { pickGiphyPreviewUrl, pickGiphySendAsset } from "../src/lib/giphyMedia";

test("photo previews preserve transparency, reduce bytes and reuse completed/versioned work", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "maiko-previews-"));
  try {
    const original = path.join(folder, "photo.png");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red@0.3:s=1200x800,format=rgba",
      "-frames:v", "1", "-threads", "1", "-compression_level", "0", original], { windowsHide: true });
    let reads = 0;
    const service = createMediaPreviewService(path.join(folder, "thumbs"));
    const request = { name: "photo.png", version: "one", width: 430, source: async () => { reads++; return original; } };
    const frames = await Promise.all(Array.from({ length: 8 }, () => service.get(request)));
    assert.ok(frames[0]);
    assert.ok(frames.every(frame => frame?.filename === frames[0]!.filename));
    assert.equal(reads, 1);
    assert.ok(frames[0].size < (await readFile(original)).length / 20);
    const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,pix_fmt", "-of", "json", frames[0].filename], { encoding: "utf8", windowsHide: true }));
    assert.equal(metadata.streams[0].width, 430);
    assert.match(metadata.streams[0].pix_fmt, /a/); // Alpha survives PNG -> WebP.
    await service.get(request);
    assert.equal(reads, 1);
    const changed = await service.get({ ...request, version: "two" });
    assert.ok(changed);
    assert.notEqual(changed.filename, frames[0].filename);
    assert.equal(reads, 2);
    console.log(JSON.stringify({ originalBytes: (await readFile(original)).length, previewBytes: frames[0].size }));
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
