/** Build normalized peak bars from PCM samples (0..1). */
export function peaksFromChannelData(
  data: Float32Array,
  barCount: number,
): number[] {
  const count = Math.max(8, Math.min(barCount, 192));
  const block = Math.max(1, Math.floor(data.length / count));
  const peaks: number[] = [];
  let max = 0.0001;

  for (let i = 0; i < count; i += 1) {
    const start = i * block;
    const end = Math.min(data.length, start + block);
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const v = Math.abs(data[j] || 0);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
    if (peak > max) max = peak;
  }

  return peaks.map((peak) => Math.min(1, Math.max(0.08, peak / max)));
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

export async function peaksFromAudioUrl(
  url: string,
  barCount: number,
  signal?: AbortSignal,
): Promise<{ peaks: number[]; duration: number } | null> {
  const key = `${url}#${barCount}`;
  const cached = waveformCache.get(key);
  if (cached) return cached;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (signal?.aborted) return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      const decoded = await ctx.decodeAudioData(buffer.slice(0));
      const channel = decoded.getChannelData(0);
      const peaks = peaksFromChannelData(channel, barCount);
      const duration = Number.isFinite(decoded.duration) ? decoded.duration : 0;
      const data = { peaks, duration };
      waveformCache.set(key, data);
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

  let x = 0;
  bars.forEach((level) => {
    const barWidth = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    const barHeight = Math.max(2 * dpr, level * height * 0.92);
    const y = (height - barHeight) / 2;
    ctx.fillStyle = x + barWidth / 2 <= progressX ? options.progressColor : options.color;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, barWidth, barHeight, dpr);
    } else {
      ctx.rect(x, y, barWidth, barHeight);
    }
    ctx.fill();
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
