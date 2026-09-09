/** Shared WebRTC media helpers for calls and voice channels. */

export const CAMERA_VIDEO_CONSTRAINTS = {
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: "user",
} as MediaTrackConstraints;

export const CAMERA_SEND_PARAMS = {
  maxBitrate: 1_500_000,
  maxFramerate: 24,
} as const;

/** Speech-oriented Opus cap — enough for voice, leaves headroom for video. */
export const AUDIO_SEND_PARAMS = {
  maxBitrate: 48_000,
} as const;

export type CallNetworkLevel = "good" | "ok" | "poor";

export type CallNetworkSample = {
  rttMs: number;
  lossPct: number;
  jitterMs: number;
  availableBitrate: number;
};

export type CallVideoQuality = {
  label: "1080" | "720" | "540" | "360";
  maxBitrate: number;
  maxFramerate: number;
  scale: number;
};

export type CallStatsCursor = {
  lost: number;
  recv: number;
};

export const SCREEN_CAPTURE_CONSTRAINTS = {
  video: {
    width: { ideal: 1920, max: 2560 },
    height: { ideal: 1080, max: 1440 },
    frameRate: { ideal: 30, max: 30 },
  } as MediaTrackConstraints,
  audio: {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
    // Keep Pulse's remote playback out of system/tab loopback.
    restrictOwnAudio: true,
  } as MediaTrackConstraints,
};

export const SCREEN_SEND_PARAMS = {
  maxBitrate: 2_800_000,
  maxFramerate: 24,
} as const;

export function emptyCallStatsCursor(): CallStatsCursor {
  return { lost: 0, recv: 0 };
}

export function readCallNetworkSample(
  report: RTCStatsReport,
  cursor: CallStatsCursor,
): CallNetworkSample | null {
  let rttMs = 0;
  let availableBitrate = 0;
  let jitterMs = 0;
  let lost = 0;
  let recv = 0;

  report.forEach((stat) => {
    if (stat.type === "candidate-pair") {
      const pair = stat as {
        state?: string;
        nominated?: boolean;
        currentRoundTripTime?: number;
        availableOutgoingBitrate?: number;
      };
      if (pair.state !== "succeeded" && !pair.nominated) return;
      const rtt = Number(pair.currentRoundTripTime);
      if (Number.isFinite(rtt) && rtt >= 0) {
        rttMs = Math.max(rttMs, Math.round(rtt * 1000));
      }
      const bitrate = Number(pair.availableOutgoingBitrate);
      if (Number.isFinite(bitrate) && bitrate > availableBitrate) {
        availableBitrate = bitrate;
      }
    }
    if (stat.type === "inbound-rtp") {
      const inbound = stat as {
        packetsLost?: number;
        packetsReceived?: number;
        jitter?: number;
      };
      lost += Math.max(0, Number(inbound.packetsLost) || 0);
      recv += Math.max(0, Number(inbound.packetsReceived) || 0);
      const jitter = Number(inbound.jitter);
      if (Number.isFinite(jitter) && jitter > 0) {
        jitterMs = Math.max(jitterMs, Math.round(jitter * 1000));
      }
    }
  });

  const dLost = Math.max(0, lost - cursor.lost);
  const dRecv = Math.max(0, recv - cursor.recv);
  cursor.lost = lost;
  cursor.recv = recv;
  const total = dLost + dRecv;
  const lossPct = total > 0 ? (dLost / total) * 100 : 0;
  if (!rttMs && !lossPct && !availableBitrate) return null;
  return { rttMs, lossPct, jitterMs, availableBitrate };
}

export function callNetworkLevel(sample: CallNetworkSample): CallNetworkLevel {
  if (
    sample.lossPct > 8 ||
    sample.rttMs > 280 ||
    sample.jitterMs > 50 ||
    (sample.availableBitrate > 0 && sample.availableBitrate < 400_000)
  ) {
    return "poor";
  }
  if (
    sample.lossPct > 3 ||
    sample.rttMs > 160 ||
    sample.jitterMs > 30 ||
    (sample.availableBitrate > 0 && sample.availableBitrate < 1_000_000)
  ) {
    return "ok";
  }
  return "good";
}

export function videoQualityForCall(
  kind: "camera" | "screen",
  level: CallNetworkLevel,
  hidden = false,
): CallVideoQuality {
  if (hidden) {
    return kind === "screen"
      ? { label: "540", maxBitrate: 800_000, maxFramerate: 10, scale: 2 }
      : { label: "360", maxBitrate: 250_000, maxFramerate: 8, scale: 2 };
  }
  if (kind === "screen") {
    if (level === "poor") {
      return { label: "540", maxBitrate: 1_200_000, maxFramerate: 15, scale: 2 };
    }
    if (level === "ok") {
      return { label: "720", maxBitrate: 1_800_000, maxFramerate: 20, scale: 1.5 };
    }
    return {
      label: "1080",
      maxBitrate: SCREEN_SEND_PARAMS.maxBitrate,
      maxFramerate: SCREEN_SEND_PARAMS.maxFramerate,
      scale: 1,
    };
  }
  if (level === "poor") {
    return { label: "360", maxBitrate: 500_000, maxFramerate: 12, scale: 2 };
  }
  if (level === "ok") {
    return { label: "540", maxBitrate: 900_000, maxFramerate: 20, scale: 1.5 };
  }
  return {
    label: "720",
    maxBitrate: CAMERA_SEND_PARAMS.maxBitrate,
    maxFramerate: CAMERA_SEND_PARAMS.maxFramerate,
    scale: 1,
  };
}

export function prepareScreenAudioTrack(track: MediaStreamTrack) {
  try {
    track.contentHint = "music";
  } catch {
    /* older browsers */
  }
}

type ScreenDisplayOptions = DisplayMediaStreamOptions & {
  systemAudio?: "include" | "exclude";
  suppressLocalAudioPlayback?: boolean;
};

function displaySurfaceOf(stream: MediaStream) {
  const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
  return (settings as { displaySurface?: string }).displaySurface;
}

function sanitizeScreenAudio(stream: MediaStream) {
  const surface = displaySurfaceOf(stream);
  for (const track of stream.getAudioTracks()) {
    try {
      void track.applyConstraints({
        echoCancellation: true,
        restrictOwnAudio: true,
      } as MediaTrackConstraints);
    } catch {
      /* older browsers */
    }
    const restricted =
      (track.getSettings() as { restrictOwnAudio?: boolean }).restrictOwnAudio ===
      true;
    // Full-screen capture is speaker loopback and includes the other person
    // unless the browser excluded this tab's audio.
    if (surface === "monitor" && !restricted) {
      track.stop();
      stream.removeTrack(track);
      continue;
    }
    prepareScreenAudioTrack(track);
  }
  return stream;
}

function displayCaptureFailed(error: unknown) {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: string }).name)
      : "";
  return (
    name === "NotSupportedError" ||
    name === "OverconstrainedError" ||
    name === "TypeError"
  );
}

/** Screen share with content audio, without capturing the call from speakers. */
export async function captureScreenShare() {
  const video = SCREEN_CAPTURE_CONSTRAINTS.video;
  const audio = SCREEN_CAPTURE_CONSTRAINTS.audio;
  const attempts: ScreenDisplayOptions[] = [
    {
      video,
      audio,
      systemAudio: "include",
      suppressLocalAudioPlayback: true,
    },
    {
      video,
      audio: true,
      systemAudio: "include",
      suppressLocalAudioPlayback: true,
    },
    { video, audio: true },
    { video, audio: false },
  ];
  let lastError: unknown;
  for (const options of attempts) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(options);
      return sanitizeScreenAudio(stream);
    } catch (error) {
      lastError = error;
      if (!displayCaptureFailed(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("screen-share-failed");
}

export async function attachLocalScreenAudioTrack(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
) {
  prepareScreenAudioTrack(track);
  const existing = pc
    .getSenders()
    .find(
      (sender) =>
        sender.track?.kind === "audio" && sender.track.contentHint === "music",
    );
  if (existing) {
    existing.setStreams?.(stream);
    await existing.replaceTrack(track);
    return existing;
  }
  return pc.addTrack(track, stream);
}

export async function detachLocalScreenAudioTrack(
  pc: RTCPeerConnection,
  track?: MediaStreamTrack | null,
) {
  const sender = pc.getSenders().find(
    (item) =>
      (track && item.track === track) ||
      (item.track?.kind === "audio" && item.track.contentHint === "music"),
  );
  if (!sender) return;
  try {
    await sender.replaceTrack(null);
  } catch {
    /* ignore */
  }
  try {
    pc.removeTrack(sender);
  } catch {
    /* ignore */
  }
}

export function prepareCameraTrack(track: MediaStreamTrack) {
  try {
    track.contentHint = "motion";
  } catch {
    /* older browsers */
  }
}

export function prepareScreenTrack(track: MediaStreamTrack) {
  try {
    track.contentHint = "detail";
  } catch {
    /* older browsers */
  }
}

export function findVideoSender(pc: RTCPeerConnection) {
  const withTrack = pc
    .getSenders()
    .find((sender) => sender.track?.kind === "video");
  if (withTrack) return withTrack;
  const transceiver = pc
    .getTransceivers()
    .find(
      (item) =>
        item.receiver.track.kind === "video" ||
        item.sender.track?.kind === "video",
    );
  return transceiver?.sender || null;
}

export async function attachLocalVideoTrack(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
) {
  let sender = findVideoSender(pc);
  if (!sender) {
    sender = pc.addTrack(track, stream);
  } else {
    const existingTransceiver = pc
      .getTransceivers()
      .find((item) => item.sender === sender);
    if (
      existingTransceiver &&
      existingTransceiver.direction !== "sendrecv"
    ) {
      existingTransceiver.direction = "sendrecv";
    }
    sender.setStreams?.(stream);
    await sender.replaceTrack(track);
  }
  const transceiver = pc
    .getTransceivers()
    .find((item) => item.sender === sender);
  if (transceiver && transceiver.direction !== "sendrecv") {
    transceiver.direction = "sendrecv";
  }
  sender.setStreams?.(stream);
  return sender;
}

export async function replaceAudioSenders(
  pcs: Iterable<RTCPeerConnection | null | undefined>,
  stream: MediaStream,
  track: MediaStreamTrack,
) {
  for (const pc of pcs) {
    if (!pc) continue;
    const sender =
      pc.getSenders().find(
        (item) =>
          item.track?.kind === "audio" && item.track.contentHint !== "music",
      ) ||
      pc
        .getTransceivers()
        .find((item) => item.receiver.track.kind === "audio")?.sender;
    if (sender) {
      sender.setStreams?.(stream);
      await sender.replaceTrack(track);
    } else {
      pc.addTrack(track, stream);
    }
  }
}

export function withReplacedAudioTrack(
  previous: MediaStream | null,
  audioTrack: MediaStreamTrack,
) {
  const extras =
    previous
      ?.getTracks()
      .filter(
        (track) =>
          track.readyState === "live" &&
          track.id !== audioTrack.id &&
          (track.kind === "video" || track.contentHint === "music"),
      ) || [];
  return new MediaStream([audioTrack, ...extras]);
}

/** Attach camera/screen as separate senders so both can publish at once. */
export async function attachLocalVideoTrackByHint(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
  hint: "motion" | "detail",
) {
  const matched = pc
    .getSenders()
    .find(
      (sender) =>
        sender.track?.kind === "video" && sender.track.contentHint === hint,
    );
  if (matched) {
    matched.setStreams?.(stream);
    await matched.replaceTrack(track);
    return matched;
  }

  const videoTransceivers = pc
    .getTransceivers()
    .filter(
      (item) =>
        item.receiver.track.kind === "video" ||
        item.sender.track?.kind === "video",
    );
  const liveVideoSenders = pc
    .getSenders()
    .filter((sender) => sender.track?.kind === "video");

  // Reuse the recvonly placeholder instead of adding a second m-line.
  const empty = videoTransceivers.find((item) => !item.sender.track);
  if (empty && liveVideoSenders.length === 0) {
    empty.direction = "sendrecv";
    empty.sender.setStreams?.(stream);
    await empty.sender.replaceTrack(track);
    return empty.sender;
  }

  if (liveVideoSenders.length >= 1) {
    return pc.addTrack(track, stream);
  }
  return attachLocalVideoTrack(pc, track, stream);
}

export async function detachLocalVideoTrackByHint(
  pc: RTCPeerConnection,
  hint: "motion" | "detail",
) {
  const sender = pc
    .getSenders()
    .find(
      (item) =>
        item.track?.kind === "video" && item.track.contentHint === hint,
    );
  if (!sender) return;
  try {
    await sender.replaceTrack(null);
  } catch {
    /* ignore */
  }
  try {
    pc.removeTrack(sender);
  } catch {
    /* ignore */
  }
}

export async function applyVideoSenderParams(
  sender: RTCRtpSender | undefined,
  opts: {
    maxBitrate: number;
    maxFramerate: number;
    maintainResolution?: boolean;
    scaleResolutionDownBy?: number;
  },
) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = opts.maxBitrate;
    params.encodings[0].maxFramerate = opts.maxFramerate;
    params.encodings[0].scaleResolutionDownBy = opts.scaleResolutionDownBy ?? 1;
    if (opts.maintainResolution) {
      (params as RTCRtpSendParameters & {
        degradationPreference?: string;
      }).degradationPreference = "maintain-resolution";
    }
    await sender.setParameters(params);
  } catch {
    /* browser may reject mid-call tweaks */
  }
}

export async function applyAudioSenderParams(
  sender: RTCRtpSender | undefined,
  maxBitrate = AUDIO_SEND_PARAMS.maxBitrate,
) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = maxBitrate;
    await sender.setParameters(params);
  } catch {
    /* encodings are empty until the first negotiation on some browsers */
  }
}

export async function applyAudioSenders(
  pcs: Iterable<RTCPeerConnection | null | undefined>,
) {
  for (const pc of pcs) {
    if (!pc) continue;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "audio") continue;
      if (sender.track.contentHint === "music") continue;
      await applyAudioSenderParams(sender);
    }
  }
}

function preferOpusCodecs(pc: RTCPeerConnection) {
  if (typeof RTCRtpSender.getCapabilities !== "function") return;
  const caps = RTCRtpSender.getCapabilities("audio");
  if (!caps?.codecs?.length) return;
  const opus = caps.codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === "audio/opus",
  );
  if (!opus.length) return;
  const rest = caps.codecs.filter(
    (codec) => codec.mimeType.toLowerCase() !== "audio/opus",
  );
  const ordered = [...opus, ...rest];
  for (const transceiver of pc.getTransceivers()) {
    if (
      transceiver.sender.track?.kind !== "audio" &&
      transceiver.receiver.track?.kind !== "audio"
    ) {
      continue;
    }
    try {
      transceiver.setCodecPreferences(ordered);
    } catch {
      /* Safari can reject mid-call preference changes */
    }
  }
}

export function patchOpusSdp(sdp: string) {
  const pts = [...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000/gim)].map(
    (match) => match[1],
  );
  if (!pts.length) return sdp;
  let next = sdp;
  for (const pt of pts) {
    const fmtp = new RegExp(`^(a=fmtp:${pt} )(.*)$`, "im");
    if (fmtp.test(next)) {
      next = next.replace(fmtp, (_line, prefix: string, params: string) => {
        let patched = params;
        if (!/useinbandfec=/i.test(patched)) patched += ";useinbandfec=1";
        else patched = patched.replace(/useinbandfec=0/i, "useinbandfec=1");
        if (!/usedtx=/i.test(patched)) patched += ";usedtx=1";
        else patched = patched.replace(/usedtx=0/i, "usedtx=1");
        if (!/maxaveragebitrate=/i.test(patched)) {
          patched += `;maxaveragebitrate=${AUDIO_SEND_PARAMS.maxBitrate}`;
        }
        if (!/stereo=/i.test(patched)) patched += ";stereo=0";
        return `${prefix}${patched}`;
      });
      continue;
    }
    next = next.replace(
      new RegExp(`^(a=rtpmap:${pt} opus\\/48000.*)$`, "im"),
      `$1\r\na=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=${AUDIO_SEND_PARAMS.maxBitrate};stereo=0`,
    );
  }
  return next;
}

export function tuneSessionDescription(desc: RTCSessionDescriptionInit) {
  if (!desc.sdp) return desc;
  return { ...desc, sdp: patchOpusSdp(desc.sdp) };
}

export async function setLocalDescriptionTuned(
  pc: RTCPeerConnection,
  desc: RTCSessionDescriptionInit,
) {
  const original = desc.sdp;
  try {
    if (desc.sdp) desc.sdp = patchOpusSdp(desc.sdp);
    await pc.setLocalDescription(desc);
  } catch {
    if (original) desc.sdp = original;
    await pc.setLocalDescription(desc);
  }
  return desc;
}

export function optimizePeerConnection(pc: RTCPeerConnection) {
  preferOpusCodecs(pc);
}

export function streamHasLiveVideo(stream: MediaStream | null) {
  return Boolean(
    stream
      ?.getVideoTracks()
      .some((track) => track.readyState === "live" && track.enabled),
  );
}

function videoTrackLooksLikeScreen(track: MediaStreamTrack) {
  const settings = track.getSettings?.() || {};
  const displaySurface = (settings as { displaySurface?: string }).displaySurface;
  if (displaySurface) return true;
  if ((settings as { facingMode?: string }).facingMode) return false;
  const hint =
    track.contentHint ||
    (settings as { contentHint?: string }).contentHint ||
    "";
  if (hint === "detail" || hint === "text") return true;
  const label = (track.label || "").toLowerCase();
  return (
    label.includes("screen") ||
    label.includes("window") ||
    label.includes("display") ||
    label.includes("monitor") ||
    label.includes("tab") ||
    label.includes("экран") ||
    label.includes("окно")
  );
}

export function streamLooksLikeScreen(stream: MediaStream | null) {
  const track = stream
    ?.getVideoTracks()
    .find((item) => item.readyState === "live" && item.enabled);
  if (!track) return false;
  return videoTrackLooksLikeScreen(track);
}

function liveVideoTracks(stream: MediaStream) {
  return stream
    .getVideoTracks()
    .filter((track) => track.readyState === "live");
}

/** Prefer a camera track when a stream carries both camera and screen. */
export function pickCameraStream(stream: MediaStream | null) {
  if (!stream) return null;
  const live = liveVideoTracks(stream);
  const camera = live.find((track) => !videoTrackLooksLikeScreen(track));
  if (!camera) return null;
  if (live.length === 1) return stream;
  return new MediaStream([camera]);
}

/** Prefer a screen track when a stream carries both camera and screen. */
export function pickScreenStream(stream: MediaStream | null) {
  if (!stream) return null;
  const live = liveVideoTracks(stream);
  const screen = live.find((track) => videoTrackLooksLikeScreen(track));
  if (!screen) return null;
  if (live.length === 1) return stream;
  return new MediaStream([screen]);
}

export function streamHasCameraVideo(stream: MediaStream | null) {
  return Boolean(
    stream &&
      liveVideoTracks(stream).some((track) => !videoTrackLooksLikeScreen(track)),
  );
}

export function streamHasScreenVideo(stream: MediaStream | null) {
  return Boolean(
    stream &&
      liveVideoTracks(stream).some((track) => videoTrackLooksLikeScreen(track)),
  );
}
