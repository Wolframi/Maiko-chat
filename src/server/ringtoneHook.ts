import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RINGTONE_CLIP_SEC = 45;
export const RINGTONE_FADE_IN_SEC = 0.09;
export const RINGTONE_FADE_OUT_SEC = 0.4;
export const HOOK_CACHE_VERSION = 3;

const HOP_SEC = 0.08;
const WIN_SEC = 0.36;
const LOOKAHEAD_SEC = 3.2;
const LOOKBEHIND_SEC = 0.7;
const ANALYZE_MAX_SEC = 90;
const ESSENTIA_SLICE_SEC = 8;
const ESSENTIA_TIMEOUT_MS = 2500;

function workerPath() {
  const here = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "essentiaOnsets.cjs",
  );
  if (existsSync(here)) return here;
  return path.join(process.cwd(), "src", "server", "essentiaOnsets.cjs");
}

export function pcmS16leToFloat32(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[i];
}

function meanRange(arr: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(arr.length, Math.ceil(to));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += arr[i];
  return sum / (b - a);
}

function smooth(arr: Float32Array, radius = 2): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= arr.length) continue;
      sum += arr[j];
      n += 1;
    }
    out[i] = sum / Math.max(1, n);
  }
  return out;
}

function envelopes(samples: Float32Array, sampleRate: number) {
  const hop = Math.max(1, Math.floor(sampleRate * HOP_SEC));
  const win = Math.max(1, Math.floor(sampleRate * WIN_SEC));
  const n = Math.max(1, Math.floor((samples.length - win) / hop));
  const rms = new Float32Array(n);
  const hfc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * hop;
    let energy = 0;
    let hf = 0;
    let prev = samples[start] || 0;
    for (let j = 0; j < win; j++) {
      const s = samples[start + j] || 0;
      energy += s * s;
      const d = s - prev;
      hf += d * d;
      prev = s;
    }
    rms[i] = Math.sqrt(energy / win);
    hfc[i] = Math.sqrt(hf / win);
  }
  return { rms: smooth(rms, 2), hfc: smooth(hfc, 1), hopSec: HOP_SEC };
}

/**
 * First chorus/drop: loud, sustained, and (if possible) a musical onset —
 * not a one-off spike or a late outro crash.
 */
export function findHookStartSec(
  samples: Float32Array,
  sampleRate = 22050,
  extraOnsets: number[] = [],
): number {
  const duration = samples.length / sampleRate;
  if (duration < 1.2) return 0;

  const analyzeLen = Math.min(samples.length, Math.floor(ANALYZE_MAX_SEC * sampleRate));
  const slice =
    analyzeLen < samples.length ? samples.subarray(0, analyzeLen) : samples;
  const { rms, hfc, hopSec } = envelopes(slice, sampleRate);
  if (rms.length < 4) return 0;

  const pLoud = percentile(rms, 0.92);
  const pHfc = Math.max(percentile(hfc, 0.9), 1e-8);
  if (pLoud <= 1e-6) return 0;

  const lookahead = Math.max(1, Math.round(LOOKAHEAD_SEC / hopSec));
  const lookbehind = Math.max(1, Math.round(LOOKBEHIND_SEC / hopSec));
  const minTail = Math.min(8, Math.max(2, duration * 0.25));
  const latestStart = Math.max(0, duration - minTail);
  const latestFrame = Math.max(0, Math.floor(latestStart / hopSec));

  const candidates = new Set<number>();
  for (let i = lookbehind; i < rms.length - 2 && i <= latestFrame; i++) {
    const before = meanRange(rms, i - lookbehind, i);
    if (before < pLoud * 0.42 && rms[i] > pLoud * 0.55) candidates.add(i);
  }
  for (const t of extraOnsets) {
    const i = Math.round(t / hopSec);
    if (i >= 0 && i < rms.length && i <= latestFrame) {
      candidates.add(i);
      if (i > 0) candidates.add(i - 1);
    }
  }
  if (candidates.size < 5) {
    for (let i = 0; i <= latestFrame; i += 3) candidates.add(i);
  }

  const scored: { frame: number; score: number }[] = [];
  let bestScore = -1;
  for (const i of candidates) {
    const after = meanRange(rms, i, i + lookahead);
    const before = meanRange(rms, Math.max(0, i - lookbehind), i);
    const afterHfc = meanRange(hfc, i, i + Math.round(1.2 / hopSec));
    const jump = after / Math.max(before, pLoud * 0.08);
    const nearOnset = extraOnsets.some(
      (t) => Math.abs(t - i * hopSec) < 0.18,
    );
    const score =
      after *
      Math.pow(Math.min(jump, 8), 0.35) *
      (1 + afterHfc / pHfc) *
      (nearOnset ? 1.18 : 1);
    scored.push({ frame: i, score });
    if (score > bestScore) bestScore = score;
  }
  if (bestScore < 0 || scored.length === 0) return 0;

  scored.sort((a, b) => a.frame - b.frame);
  const pick =
    scored.find((row) => row.score >= bestScore * 0.84) || scored[0];

  let startFrame = pick.frame;
  const floor = pLoud * 0.28;
  const pad = Math.round(0.16 / hopSec);
  for (let k = 0; k < pad && startFrame > 0; k++) {
    if (rms[startFrame - 1] < floor) break;
    startFrame -= 1;
  }

  const startSec = Math.max(0, startFrame * hopSec - 0.04);
  return Math.round(startSec * 100) / 100;
}

export function findDynamicStartSec(pcm: Buffer, sampleRate = 22050): number {
  return findHookStartSec(pcmS16leToFloat32(pcm), sampleRate);
}

function spawnEssentiaOnsets(
  samples: Float32Array,
  sampleRate: number,
): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath(), String(sampleRate)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (onsets: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(onsets);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish([]);
    }, ESSENTIA_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish([]));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout) as { onsets?: unknown };
        const onsets = Array.isArray(parsed.onsets)
          ? parsed.onsets
              .map((t) => Number(t))
              .filter((t) => Number.isFinite(t) && t >= 0)
          : [];
        finish(onsets);
      } catch {
        finish([]);
      }
    });
    const buf = Buffer.from(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength,
    );
    child.stdin.on("error", () => finish([]));
    child.stdin.end(buf);
  });
}

async function snapToEssentiaOnset(
  samples: Float32Array,
  sampleRate: number,
  coarseSec: number,
): Promise<number> {
  const sliceStart = Math.max(0, coarseSec - 1.25);
  const sliceLen = Math.min(
    samples.length - Math.floor(sliceStart * sampleRate),
    Math.floor(ESSENTIA_SLICE_SEC * sampleRate),
  );
  if (sliceLen < sampleRate) return coarseSec;
  const from = Math.floor(sliceStart * sampleRate);
  const slice = samples.subarray(from, from + sliceLen);
  try {
    const onsets = await spawnEssentiaOnsets(slice, sampleRate);
    if (onsets.length === 0) return coarseSec;
    const target = coarseSec - sliceStart;
    let nearest = onsets[0];
    for (const t of onsets) {
      if (Math.abs(t - target) < Math.abs(nearest - target)) nearest = t;
    }
    if (Math.abs(nearest - target) > 0.75) return coarseSec;
    return Math.max(0, Math.round((sliceStart + nearest - 0.04) * 100) / 100);
  } catch (error) {
    console.error("[ringtones:essentia]", error);
    return coarseSec;
  }
}

export async function findDynamicStartSecAsync(
  pcm: Buffer,
  sampleRate = 22050,
): Promise<number> {
  const samples = pcmS16leToFloat32(pcm);
  const coarse = findHookStartSec(samples, sampleRate);
  return snapToEssentiaOnset(samples, sampleRate, coarse);
}

export function fadeFilter(clipSec: number): string {
  const dur = Math.max(0.2, clipSec);
  const fadeIn = Math.min(RINGTONE_FADE_IN_SEC, dur * 0.12);
  const fadeOut = Math.min(RINGTONE_FADE_OUT_SEC, dur * 0.22);
  const outSt = Math.max(0, Number((dur - fadeOut).toFixed(3)));
  return `afade=t=in:st=0:d=${fadeIn.toFixed(3)}:curve=hsin,afade=t=out:st=${outSt}:d=${fadeOut.toFixed(3)}:curve=hsin`;
}
