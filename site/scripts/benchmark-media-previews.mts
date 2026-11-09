import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { createMediaPreviewService } from "../src/server/mediaPreview";

// Compare uncached generation on local originals, including one process per ffmpeg job.
// Optional positional arguments select image files or folders (non-recursive).
const inputs = process.argv.slice(2);
const width = 430;
const runs = 3;
const extensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const files: string[] = [];
for (const input of inputs.length ? inputs : ["uploads"]) {
  const resolved = path.resolve(input);
  const info = await stat(resolved);
  const candidates = info.isDirectory()
    ? (await readdir(resolved, { withFileTypes: true })).filter(item => item.isFile()).map(item => path.join(resolved, item.name))
    : [resolved];
  files.push(...candidates.filter(filename => extensions.has(path.extname(filename).toLowerCase())));
}
const originals = [...new Set(files)].sort();
assert.ok(originals.length, "No supported photos found");
const corpus = await Promise.all(originals.map(async filename => {
  const info = await stat(filename);
  const metadata = await sharp(filename).metadata();
  return { file: path.relative(process.cwd(), filename), bytes: info.size, width: metadata.width, height: metadata.height,
    orientedWidth: metadata.autoOrient.width, orientedHeight: metadata.autoOrient.height, hasAlpha: metadata.hasAlpha,
    transparent: metadata.hasAlpha && !(await sharp(filename).stats()).isOpaque };
}));
const temporary = await mkdtemp(path.join(tmpdir(), "maiko-preview-bench-"));
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
type Engine = "ffmpeg" | "sharp";
type Sample = { engine: Engine; concurrency: number; run: number; totalMs: number; latenciesMs: number[]; bytes: number[] };
const samples: Sample[] = [];

async function ffmpeg(original: string, destination: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-y", "-threads", "1", "-i", original,
      "-vf", `scale=w='min(${width},iw)':h=-2`, "-frames:v", "1", "-c:v", "libwebp", "-quality", "76",
      "-compression_level", "3", "-threads", "1", "-f", "webp", destination], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`ffmpeg exited ${code}`)); });
  });
}

async function batch(engine: Engine, concurrency: number, run: number, selected = originals) {
  const directory = path.join(temporary, `${engine}-${concurrency}-${run}`);
  await mkdir(directory);
  const service = createMediaPreviewService(directory, { concurrency });
  let index = 0;
  const latenciesMs: number[] = [], bytes: number[] = [], outputs: string[] = [];
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < selected.length) {
      const i = index++;
      const original = selected[i];
      const since = performance.now();
      let filename: string;
      if (engine === "sharp") {
        const frame = await service.get({ name: path.basename(original), version: `${run}:${i}`, width, source: async () => original });
        assert.ok(frame, `Failed to preview ${original}`);
        filename = frame.filename;
        bytes[i] = frame.size;
      } else {
        filename = path.join(directory, `${i}.webp`);
        await ffmpeg(original, filename);
        bytes[i] = (await stat(filename)).size;
      }
      latenciesMs[i] = performance.now() - since;
      outputs[i] = filename;
    }
  }));
  const totalMs = performance.now() - start;
  // Validate outside the measured interval. Images may differ by one row due to ffmpeg's even height.
  if (run === 0) {
    for (let i = 0; i < selected.length; i++) {
      const metadata = await sharp(outputs[i]).metadata();
      const input = corpus[originals.indexOf(selected[i])];
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.width, Math.min(width, input.orientedWidth));
      assert.ok(Math.abs(metadata.height - input.orientedHeight * metadata.width / input.orientedWidth) <= 2);
      if (input.transparent) assert.equal(metadata.hasAlpha, true, `${engine}: alpha missing for ${input.file}`);
    }
  }
  return { engine, concurrency, run, totalMs, latenciesMs, bytes };
}

try {
  // Exclude module loading and warm-up from both engines; regenerate every preview on every run.
  await batch("ffmpeg", 1, -1, originals.slice(0, 1));
  await batch("sharp", 1, -1, originals.slice(0, 1));
  for (const concurrency of [1, 2]) {
    for (let run = 0; run < runs; run++) {
      const order: Engine[] = run % 2 ? ["sharp", "ffmpeg"] : ["ffmpeg", "sharp"];
      for (const engine of order) {
        const sample = await batch(engine, concurrency, run);
        samples.push(sample);
        console.log(`${engine}, concurrency ${concurrency}, run ${run + 1}: ${sample.totalMs.toFixed(0)} ms`);
      }
    }
  }
  const summary = [1, 2].map(concurrency => {
    const engineStats = (engine: Engine) => {
      const matching = samples.filter(sample => sample.engine === engine && sample.concurrency === concurrency);
      const totalMs = median(matching.map(sample => sample.totalMs));
      return { medianBatchMs: totalMs, photosPerSecond: originals.length / (totalMs / 1000),
        medianPhotoMs: median(matching.flatMap(sample => sample.latenciesMs)),
        outputBytes: matching[0].bytes.reduce((a, b) => a + b, 0) };
    };
    const old = engineStats("ffmpeg"), current = engineStats("sharp");
    return { concurrency, ffmpeg: old, sharp: current, speedup: old.medianBatchMs / current.medianBatchMs };
  });
  const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, versions: sharp.versions,
    ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0],
    width, quality: 76, effort: 3, runs, cache: "uncached previews, warm runtime and OS cache; local files only",
    corpus, summary, samples };
  const output = path.resolve("../output/media-preview-benchmark.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ photos: corpus.length, summary, report: output }, null, 2));
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith("maiko-preview-bench-"));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
