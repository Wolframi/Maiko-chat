import { AUTO_RINGTONE_SECONDS, RINGTONE_CACHE_VERSION } from "../lib/ringtoneConfig";

export const RINGTONE_CLIP_SEC = AUTO_RINGTONE_SECONDS;
export const RINGTONE_FADE_IN_SEC = 0.09;
export const RINGTONE_FADE_OUT_SEC = 0.4;
export const HOOK_CACHE_VERSION = RINGTONE_CACHE_VERSION;

export function pcmS16leToFloat32(pcm: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}

/** Score every complete 30-second window across the whole recording in O(n).
 * Non-overlapping frames keep analysis cheap; sustained energy outweighs spikes.
 * High-frequency movement adds a small preference for rhythm over a flat drone.
 */
export function findHookStartSec(samples: Float32Array, sampleRate = 22050): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  const duration = samples.length / sampleRate;
  if (duration <= RINGTONE_CLIP_SEC) return 0;
  const frameSize = Math.max(1, Math.round(sampleRate * 0.1));
  const frameCount = Math.floor(samples.length / frameSize);
  const windowFrames = Math.max(1, Math.round(RINGTONE_CLIP_SEC * sampleRate / frameSize));
  if (frameCount < windowFrames) return 0;
  const sums = new Float64Array(frameCount + 1);
  for (let frame = 0; frame < frameCount; frame++) {
    const from = frame * frameSize;
    let energy = 0;
    let movement = 0;
    let previous = samples[from];
    for (let i = from; i < from + frameSize; i++) {
      const value = samples[i];
      energy += value * value;
      const delta = value - previous;
      movement += delta * delta;
      previous = value;
    }
    sums[frame + 1] = sums[frame] + Math.sqrt(energy / frameSize) +
      0.2 * Math.sqrt(movement / frameSize);
  }
  let bestStart = 0;
  let bestScore = 0;
  for (let from = 0; from + windowFrames <= frameCount; from++) {
    const score = sums[from + windowFrames] - sums[from];
    if (score > bestScore + Math.max(1e-8, bestScore * 0.0001)) {
      bestScore = score;
      bestStart = from;
    }
  }
  return Math.max(0, Math.min(duration - RINGTONE_CLIP_SEC, bestStart * frameSize / sampleRate));
}

export function findDynamicStartSec(pcm: Buffer, sampleRate = 22050): number {
  return findHookStartSec(pcmS16leToFloat32(pcm), sampleRate);
}

export async function findDynamicStartSecAsync(pcm: Buffer, sampleRate = 22050): Promise<number> {
  return findDynamicStartSec(pcm, sampleRate);
}

export function fadeFilter(clipSec: number): string {
  const dur = Math.max(0.2, clipSec);
  const fadeIn = Math.min(RINGTONE_FADE_IN_SEC, dur * 0.12);
  const fadeOut = Math.min(RINGTONE_FADE_OUT_SEC, dur * 0.22);
  const outSt = Math.max(0, Number((dur - fadeOut).toFixed(3)));
  return `afade=t=in:st=0:d=${fadeIn.toFixed(3)}:curve=hsin,afade=t=out:st=${outSt}:d=${fadeOut.toFixed(3)}:curve=hsin`;
}
