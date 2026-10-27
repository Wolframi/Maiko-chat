// Keep the screen signal separate from video and microphone playback. Symbol.for
// also preserves access from the desktop UI's same-origin child frame.
const screenAudioKey = Symbol.for("mayko.screen-audio-tracks");
type ScreenAudioCarrier = MediaStream & {
  [key: symbol]: readonly MediaStreamTrack[] | undefined;
};

export function withScreenAudioTracks(
  stream: MediaStream,
  tracks: readonly MediaStreamTrack[],
) {
  Object.defineProperty(stream, screenAudioKey, {
    configurable: true,
    value: tracks,
  });
  return stream;
}

export function getScreenAudioTracks(stream: MediaStream | null | undefined) {
  if (!stream) return [];
  return ((stream as ScreenAudioCarrier)[screenAudioKey] ??
    stream.getAudioTracks().filter((track) => track.contentHint === "music"))
    .filter((track) => track.readyState === "live");
}

/** Keep Web Audio in the same permanent document as native desktop capture. */
export function getScreenAudioOwnerWindow(): Window & typeof globalThis {
  try {
    const parent = window.parent as Window & typeof globalThis;
    if (parent !== window && parent.location.origin === window.location.origin &&
      parent.maikoMediaRuntime?.version === 1) return parent;
  } catch {
    // Cross-origin embedding is never an audio owner.
  }
  return window;
}
