import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { maybeTranscodeVideoForBrowser } from "../src/server/videoTranscode";

for (const [width, height] of [[161, 91], [91, 161]]) {
  test(`odd ${width}x${height} MOV converts to browser-safe H.264 with even dimensions`, async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "maiko-video-transcode-"));
    try {
      const original = path.join(folder, "clip.mov");
      const create = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
        `testsrc=size=${width}x${height}:rate=5`, "-t", "0.2", "-c:v", "png", "-threads", "1", "-pix_fmt", "rgb24", original],
      { windowsHide: true, encoding: "utf8" });
      assert.equal(create.status, 0, create.stderr);
      const converted = await maybeTranscodeVideoForBrowser(original, "video/quicktime");
      assert.ok(converted, "Conversion must succeed on the installed ffmpeg");
      const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=codec_name,pix_fmt,width,height,sample_aspect_ratio", "-of", "json", converted.path],
      { windowsHide: true, encoding: "utf8" });
      assert.equal(probe.status, 0, probe.stderr);
      const stream = JSON.parse(probe.stdout).streams[0];
      assert.equal(stream.codec_name, "h264");
      assert.equal(stream.pix_fmt, "yuv420p");
      assert.equal(stream.width, 720);
      assert.equal(stream.height % 2, 0);
      assert.equal(stream.sample_aspect_ratio, "1:1");
      assert.ok(Math.abs(stream.width / stream.height - width / height) < 0.005);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}
