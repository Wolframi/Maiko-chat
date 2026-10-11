import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { peaksFromChannelData } from "../lib/waveform";

type Waveform = { peaks: number[]; duration: number };
const directory = path.join(process.cwd(), "data", "waveforms");
const jobs = new Map<string, Promise<Waveform | null>>();
let running = 0;
const queue: (() => void)[] = [];

async function slot() {
  if (running >= 3) await new Promise<void>((resolve) => queue.push(resolve));
  else running += 1;
  return () => {
    const next = queue.shift();
    if (next) next();
    else running -= 1;
  };
}

function decode(filename: string): Promise<Waveform | null> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-v", "error", "-nostdin", "-threads", "1", "-i", filename,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    const stop = () => { stopped = true; child.kill("SIGKILL"); };
    const timeout = setTimeout(stop, 45_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { stop(); return; }
      chunks.push(chunk);
    });
    child.once("error", () => { clearTimeout(timeout); resolve(null); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (stopped || code !== 0 || !size) { resolve(null); return; }
      const bytes = Buffer.concat(chunks);
      const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      resolve({ peaks: peaksFromChannelData(samples, 160).map((n) => Math.round(n * 1000) / 1000), duration: samples.length / 8000 });
    });
  });
}

/** Cached by file name. The job is registered before any await so callers share one decode. */
export function audioWaveform(
  identity: string,
  withSource: (consume: (filename: string) => Promise<Waveform | null>) => Promise<Waveform | null>,
): Promise<Waveform | null> {
  const key = createHash("sha256").update(`v2:${identity}`).digest("hex");
  const cachedPath = path.join(directory, `${key}.json`);
  const existing = jobs.get(key);
  if (existing) return existing;
  const job = (async () => {
    try {
      return JSON.parse(await readFile(cachedPath, "utf8")) as Waveform;
    } catch { /* cache miss */ }
    const release = await slot();
    try {
      const data = await withSource(decode);
      if (data) {
        await mkdir(directory, { recursive: true });
        await writeFile(`${cachedPath}.tmp`, JSON.stringify(data));
        await rename(`${cachedPath}.tmp`, cachedPath);
      }
      return data;
    } catch { return null; }
    finally { release(); }
  })().finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}
