/** Cheap local VAD for avatar speaking rings (LiveKit / P2P / mesh). */

export const SPEAKING_FFT_SIZE = 256;
export const SPEAKING_SMOOTHING = 0.12;
export const SPEAKING_THRESHOLD = 0.9;
export const SPEAKING_HOLD_MS = 280;
export const SPEAKING_TICK_MS = 32;

/** Prefer the raw mic (pre-Krisp). Filtered output is often too quiet for VAD. */
export function pickSpeakingTrack(
  preferred?: MediaStreamTrack | null,
  fallbackStream?: MediaStream | null,
): MediaStreamTrack | null {
  if (
    preferred &&
    preferred.readyState === "live" &&
    preferred.enabled !== false &&
    preferred.contentHint !== "music"
  ) {
    return preferred;
  }
  return (
    fallbackStream
      ?.getAudioTracks()
      .find(
        (track) =>
          track.readyState === "live" &&
          track.enabled !== false &&
          track.contentHint !== "music",
      ) || null
  );
}

export function configureSpeakingAnalyser(analyser: AnalyserNode) {
  analyser.fftSize = SPEAKING_FFT_SIZE;
  analyser.smoothingTimeConstant = SPEAKING_SMOOTHING;
}

export type SpeakingSamples = Uint8Array<ArrayBuffer>;

export function createSpeakingSamples(): SpeakingSamples {
  return new Uint8Array(SPEAKING_FFT_SIZE);
}

export function speakingLevelFromAnalyser(
  analyser: AnalyserNode,
  buffer: SpeakingSamples,
): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  const len = buffer.length;
  for (let i = 0; i < len; i += 1) {
    const value = (buffer[i] - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / len) * 100;
}

export function startSpeakingTicker(tick: () => void): () => void {
  let raf = 0;
  let last = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (now - last < SPEAKING_TICK_MS) return;
    last = now;
    tick();
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}
