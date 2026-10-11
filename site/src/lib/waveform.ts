/** Build normalized peak bars from PCM samples (0..1). */
export function peaksFromChannelData(
  data: Float32Array,
  barCount: number,
): number[] {
  const count = Math.max(8, Math.min(barCount, 192));
  const block = Math.max(1, Math.floor(data.length / count));
  const levels: number[] = [];

  for (let i = 0; i < count; i += 1) {
    const start = i * block;
    const end = Math.min(data.length, start + block);
    let peak = 0;
    let sumSq = 0;
    const n = Math.max(1, end - start);
    for (let j = start; j < end; j += 1) {
      const v = Math.abs(data[j] || 0);
      if (v > peak) peak = v;
      sumSq += v * v;
    }
    // Brickwalled pop is all peaks ~1; RMS still follows the mix.
    levels.push(peak * 0.35 + Math.sqrt(sumSq / n) * 0.65);
  }

  let max = 0.0001;
  let min = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    if (level > max) max = level;
    if (level < min) min = level;
  }
  const span = max - min;
  // Loud masters sit in a tiny RMS band; stretch that band so verses/choruses show.
  const tight = span < max * 0.28;
  return levels.map((level) => {
    const n = tight ? (level - min) / (span || 1) : level / max;
    const shaped = tight ? n : Math.pow(Math.min(1, Math.max(0, n)), 0.55);
    return Math.min(1, Math.max(0.1, shaped));
  });
}

function resamplePeaks(peaks: number[], count: number): number[] {
  if (count <= 0) return [];
  if (peaks.length === count) return peaks;
  if (!peaks.length) return Array.from({ length: count }, () => 0.08);
  const out: number[] = new Array(count);
  const srcLen = peaks.length;
  for (let i = 0; i < count; i += 1) {
    const start = (i * srcLen) / count;
    const end = ((i + 1) * srcLen) / count;
    const from = Math.floor(start);
    const to = Math.min(srcLen, Math.max(from + 1, Math.ceil(end)));
    let peak = 0;
    for (let j = from; j < to; j += 1) {
      const value = peaks[j] || 0;
      if (value > peak) peak = value;
    }
    out[i] = peak;
  }
  return out;
}

const waveformCache = new Map<string, { peaks: number[]; duration: number }>();
const waveformJobs = new Map<string, Promise<{ peaks: number[]; duration: number } | null>>();
let activeWaveforms = 0;
const waveformQueue: (() => void)[] = [];

function waveStorage() {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readStoredWave(storageKey: string) {
  const store = waveStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(storageKey);
    if (!raw) return null;
    const data = JSON.parse(raw) as { peaks?: unknown; duration?: unknown };
    if (
      !Array.isArray(data.peaks) ||
      data.peaks.length === 0 ||
      data.peaks.length > 192 ||
      data.peaks.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
      typeof data.duration !== "number" ||
      !Number.isFinite(data.duration) ||
      data.duration <= 0
    ) {
      return null;
    }
    return { peaks: data.peaks as number[], duration: data.duration };
  } catch {
    return null;
  }
}

function writeStoredWave(storageKey: string, data: { peaks: number[]; duration: number }) {
  const store = waveStorage();
  if (!store) return;
  try {
    store.setItem(storageKey, JSON.stringify(data));
  } catch {
    /* private mode or a full session store */
  }
}

async function waveformSlot() {
  if (activeWaveforms >= 6) await new Promise<void>((resolve) => waveformQueue.push(resolve));
  else activeWaveforms += 1;
  return () => {
    const next = waveformQueue.shift();
    if (next) next();
    else activeWaveforms -= 1;
  };
}

export async function peaksFromAudioUrl(
  url: string,
  barCount: number,
  signal?: AbortSignal,
): Promise<{ peaks: number[]; duration: number } | null> {
  if (signal?.aborted) return null;
  const parsed = new URL(url, window.location.href);
  const hosted = parsed.origin === window.location.origin && parsed.pathname.startsWith("/uploads/");
  const key = `${hosted ? parsed.pathname : url}#v4`;
  const storageKey = `pulse-wave:${key}`;
  const cached = waveformCache.get(key);
  if (cached) return { peaks: resamplePeaks(cached.peaks, barCount), duration: cached.duration };
  const stored = readStoredWave(storageKey);
  if (stored) {
    waveformCache.set(key, stored);
    return { peaks: resamplePeaks(stored.peaks, barCount), duration: stored.duration };
  }
  let job = waveformJobs.get(key);
  if (!job) {
    job = (async () => {
      const release = await waveformSlot();
      try {
        const data = await loadAudioPeaks(url, hosted);
        if (data) {
          if (waveformCache.size >= 256) waveformCache.delete(waveformCache.keys().next().value!);
          waveformCache.set(key, data);
          writeStoredWave(storageKey, data);
        }
        return data;
      } finally { release(); }
    })().finally(() => waveformJobs.delete(key));
    waveformJobs.set(key, job);
  }
  const data = await job;
  if (signal?.aborted || !data) return null;
  return { peaks: resamplePeaks(data.peaks, barCount), duration: data.duration };
}

async function loadAudioPeaks(url: string, hosted: boolean) {
  try {
    if (hosted) {
      const waveUrl = new URL(url, window.location.href);
      waveUrl.searchParams.set("waveform", "1");
      try {
        const response = await fetch(waveUrl, { signal: AbortSignal.timeout(12_000) });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const data = await response.json();
          if (Array.isArray(data.peaks) && data.peaks.length > 0 && data.peaks.length <= 192 &&
            data.peaks.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
            Number.isFinite(data.duration) && data.duration > 0) {
            return { peaks: data.peaks as number[], duration: data.duration as number };
          }
        }
      } catch { /* Older servers / unavailable ffmpeg: decode on the client. */ }
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      const decoded = await ctx.decodeAudioData(buffer);
      const channel = decoded.getChannelData(0);
      const peaks = peaksFromChannelData(channel, 160);
      const duration = Number.isFinite(decoded.duration) ? decoded.duration : 0;
      const data = { peaks, duration };
      return data;
    } finally {
      void ctx.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

export function drawWaveBars(
  canvas: HTMLCanvasElement,
  peaks: number[],
  options: {
    progress?: number;
    color: string;
    progressColor: string;
    /** Playhead line across the wave (Telegram-style). */
    cursor?: boolean;
    cursorColor?: string;
  },
) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssWidth = canvas.clientWidth || 160;
  const cssHeight = canvas.clientHeight || 34;
  const width = Math.max(1, Math.floor(cssWidth * dpr));
  const height = Math.max(1, Math.floor(cssHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx || !peaks.length) return;
  ctx.clearRect(0, 0, width, height);

  const gap = Math.max(dpr, Math.round(dpr));
  const minBar = Math.max(2 * dpr, Math.round(2 * dpr));
  const fitCount = Math.max(8, Math.floor((width + gap) / (minBar + gap)));
  const bars = resamplePeaks(peaks, fitCount);
  const count = bars.length;
  const totalGap = gap * Math.max(0, count - 1);
  const barSpace = Math.max(count, width - totalGap);
  const base = Math.floor(barSpace / count);
  let extra = barSpace - base * count;
  const progress = Math.min(1, Math.max(0, options.progress ?? 0));
  const progressX = progress * width;

  const drawBar = (bx: number, bw: number, color: string, by: number, bh: number) => {
    if (bw <= 0.5) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(bx, by, bw, bh, dpr);
    } else {
      ctx.rect(bx, by, bw, bh);
    }
    ctx.fill();
  };

  let x = 0;
  bars.forEach((level) => {
    const barWidth = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    const barHeight = Math.max(2 * dpr, level * height * 0.92);
    const y = (height - barHeight) / 2;
    const barEnd = x + barWidth;
    if (progressX <= x) {
      drawBar(x, barWidth, options.color, y, barHeight);
    } else if (progressX >= barEnd) {
      drawBar(x, barWidth, options.progressColor, y, barHeight);
    } else {
      const split = progressX - x;
      drawBar(x, split, options.progressColor, y, barHeight);
      drawBar(x + split, barWidth - split, options.color, y, barHeight);
    }
    x += barWidth + gap;
  });

  if (options.cursor !== false) {
    const lineX = Math.min(width - dpr, Math.max(0, progressX));
    const cursorColor = options.cursorColor || "#ffffff";
    ctx.save();
    ctx.strokeStyle = cursorColor;
    ctx.lineWidth = Math.max(2 * dpr, 2);
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(lineX, dpr);
    ctx.lineTo(lineX, height - dpr);
    ctx.stroke();
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = Math.max(4 * dpr, 4);
    ctx.beginPath();
    ctx.moveTo(lineX, dpr);
    ctx.lineTo(lineX, height - dpr);
    ctx.stroke();
    ctx.restore();
  }
}
