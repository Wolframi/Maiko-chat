/** Shared WebRTC media helpers for calls and voice channels. */

export type CameraFacing = "user" | "environment";

/** Ideal, not exact: a bare facingMode string is an exact match and drops cameras that omit it. */
export function cameraVideoConstraints(
  facing: CameraFacing = "user",
): MediaTrackConstraints {
  return {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
    facingMode: { ideal: facing },
  };
}

export const CAMERA_VIDEO_CONSTRAINTS = cameraVideoConstraints("user");

export const CAMERA_SEND_PARAMS = {
  maxBitrate: 3_000_000,
  maxFramerate: 30,
} as const;

/** Opus speech cap. 64 kbps stays intelligible on lossy links without starving video. */
export const AUDIO_SEND_PARAMS = {
  maxBitrate: 64_000,
} as const;

/** System/tab audio from a screen share — stereo, not a speech codec. */
export const SCREEN_AUDIO_SEND_PARAMS = {
  maxBitrate: 128_000,
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
    displaySurface: "monitor",
    width: { ideal: 1920, max: 2560 },
    height: { ideal: 1080, max: 1440 },
    frameRate: { ideal: 30, max: 30 },
  } as MediaTrackConstraints,
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    suppressLocalAudioPlayback: false,
    // Best effort: isolate the call when available; warn if a window's
    // audio source cannot exclude the call.
    restrictOwnAudio: true,
  } as MediaTrackConstraints,
};

export const SCREEN_SEND_PARAMS = {
  maxBitrate: 5_000_000,
  maxFramerate: 30,
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

/** Inbound RTP flow (bytes + packets) — media flow watchdog. */
export function readInboundFlow(report: RTCStatsReport): {
  bytes: number;
  packets: number;
} {
  let bytes = 0;
  let packets = 0;
  report.forEach((stat) => {
    if (stat.type === "inbound-rtp") {
      const flow = stat as {
        bytesReceived?: number;
        packetsReceived?: number;
      };
      bytes += Math.max(0, Number(flow.bytesReceived) || 0);
      packets += Math.max(0, Number(flow.packetsReceived) || 0);
    }
  });
  return { bytes, packets };
}

export function callNetworkLevel(sample: CallNetworkSample): CallNetworkLevel {
  if (
    sample.lossPct > 10 ||
    sample.rttMs > 450 ||
    sample.jitterMs > 80 ||
    (sample.availableBitrate > 0 && sample.availableBitrate < 700_000)
  ) {
    return "poor";
  }
  if (
    sample.lossPct > 4 ||
    sample.rttMs > 250 ||
    sample.jitterMs > 45 ||
    (sample.availableBitrate > 0 && sample.availableBitrate < 2_000_000)
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
      ? { label: "720", maxBitrate: 1_200_000, maxFramerate: 8, scale: 1.5 }
      : { label: "360", maxBitrate: 400_000, maxFramerate: 12, scale: 2 };
  }
  if (kind === "screen") {
    if (level === "poor") {
      return { label: "720", maxBitrate: 1_800_000, maxFramerate: 15, scale: 1.5 };
    }
    if (level === "ok") {
      return { label: "1080", maxBitrate: 3_000_000, maxFramerate: 24, scale: 1 };
    }
    return {
      label: "1080",
      maxBitrate: SCREEN_SEND_PARAMS.maxBitrate,
      maxFramerate: SCREEN_SEND_PARAMS.maxFramerate,
      scale: 1,
    };
  }
  if (level === "poor") {
    return { label: "360", maxBitrate: 600_000, maxFramerate: 15, scale: 2 };
  }
  if (level === "ok") {
    return { label: "720", maxBitrate: 1_700_000, maxFramerate: 24, scale: 1 };
  }
  return {
    label: "1080",
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
  windowAudio?: "window" | "exclude";
  selfBrowserSurface?: "exclude";
  monitorTypeSurfaces?: "include";
  surfaceSwitching?: "exclude";
};

type ScreenAudioConstraints = MediaTrackConstraints & {
  restrictOwnAudio?: ConstrainBoolean;
};

const CALL_AUDIO_CAPTURE_HANDLE = "mayko-call-audio";

type CaptureHandleConfig = {
  handle?: string;
  exposeOrigin?: boolean;
  permittedOrigins?: string[];
};

/** Let other Mayko tabs recognize a tab playing a call, without exposing it to other sites. */
export function configureCallAudioCapture(active: boolean) {
  const devices = navigator.mediaDevices as MediaDevices & {
    setCaptureHandleConfig?: (config: CaptureHandleConfig) => void;
  };
  try {
    devices?.setCaptureHandleConfig?.(
      active
        ? {
            handle: CALL_AUDIO_CAPTURE_HANDLE,
            exposeOrigin: true,
            permittedOrigins: [window.location.origin],
          }
        : {},
    );
  } catch {
    // Capture Handle is unavailable in some browsers and embedded frames.
  }
}

function capturesCallTab(track: MediaStreamTrack | undefined) {
  const handle = (
    track as (MediaStreamTrack & {
      getCaptureHandle?: () => { handle?: string; origin?: string } | null;
    }) | undefined
  )?.getCaptureHandle?.();
  return (
    handle?.origin === window.location.origin &&
    handle?.handle === CALL_AUDIO_CAPTURE_HANDLE
  );
}

type ScreenCaptureOptions = {
  onAudioUnavailable?: (message: string) => void;
};

function hasOwnAudioRestriction(track: MediaStreamTrack) {
  return (
    (track.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean })
      .restrictOwnAudio === true
  );
}

async function sanitizeScreenAudio(
  stream: MediaStream,
  { onAudioUnavailable }: ScreenCaptureOptions,
) {
  const video = stream.getVideoTracks()[0];
  const surface = video?.getSettings().displaySurface;
  const removeAudio = (track: MediaStreamTrack, message: string) => {
    track.stop();
    stream.removeTrack(track);
    onAudioUnavailable?.(message);
  };
  const removeCallTabAudio = () => {
    if (!capturesCallTab(video)) return;
    for (const track of stream.getAudioTracks()) {
      removeAudio(
        track,
        "Звук вкладки со звонком не передаётся, чтобы собеседники не слышали эхо.",
      );
    }
  };
  removeCallTabAudio();
  for (const track of stream.getAudioTracks()) {
    prepareScreenAudioTrack(track);
    // Full-screen sharing may include the call, by design. Never drop its
    // audio just because the browser cannot isolate our playback (Windows 10).
    // A separate tab is already isolated; Capture Handle rejects call tabs.
    // Window/unknown sources may return system loopback. Try to isolate it,
    // but keep the chosen source audible if isolation is unsupported.
    if (surface === "monitor" || surface === "browser" || hasOwnAudioRestriction(track)) continue;
    try {
      await track.applyConstraints({
        restrictOwnAudio: { exact: true },
      } as ScreenAudioConstraints);
    } catch {
      // Unsupported constraints may reject asynchronously or be ignored.
    }
    if (!hasOwnAudioRestriction(track)) {
      onAudioUnavailable?.(
        "Внимание: звук окна транслируется, но браузер не смог аппаратно подавить эхо канала. Желательно использовать наушники.",
      );
    }
  }
  // A shared tab can navigate to Mayko or join a call after capture starts.
  video?.addEventListener("capturehandlechange", removeCallTabAudio);
  video?.addEventListener("ended", () => {
    video.removeEventListener("capturehandlechange", removeCallTabAudio);
  }, { once: true });
  return stream;
}

function prefersUnconstrainedScreenVideo() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Safari/i.test(ua) && !/Chrome|Chromium|Edg|Android|CriOS|FxiOS/i.test(ua);
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

/** Capture source audio, attempting call isolation when the browser supports it. */
export async function captureScreenShare(options: ScreenCaptureOptions = {}) {
  const video = prefersUnconstrainedScreenVideo()
    ? true
    : SCREEN_CAPTURE_CONSTRAINTS.video;
  const audio = SCREEN_CAPTURE_CONSTRAINTS.audio;
  const captureOptions: ScreenDisplayOptions = {
    // Offer audio for the chosen source. Verify isolation on the actual track,
    // rather than hiding desktop/window audio based on a global feature flag.
    systemAudio: "include",
    windowAudio: "window",
    selfBrowserSurface: "exclude",
    monitorTypeSurfaces: "include",
    surfaceSwitching: "exclude",
  };
  const attempts: ScreenDisplayOptions[] = [
    {
      ...captureOptions,
      video,
      audio,
    },
    {
      ...captureOptions,
      video,
      audio: true,
    },
    { ...captureOptions, video, audio: false },
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(attempt);
    } catch (error) {
      lastError = error;
      if (!displayCaptureFailed(error)) throw error;
      continue;
    }
    try {
      return await sanitizeScreenAudio(stream, options);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("screen-share-failed");
}

// A cleared sender has no track metadata. Remember its role for this PC's lifetime.
const screenAudioSenders = new WeakMap<RTCPeerConnection, RTCRtpSender>();
const remoteScreenAudioMids = new WeakMap<RTCPeerConnection, ReadonlySet<string>>();

export async function attachLocalScreenAudioTrack(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
) {
  prepareScreenAudioTrack(track);
  const senders = pc.getSenders();
  const remembered = screenAudioSenders.get(pc);
  const existing = (remembered && senders.includes(remembered) ? remembered : undefined) || senders
    .find(
      (sender) =>
        sender.track?.kind === "audio" && sender.track.contentHint === "music",
    );
  let sender = existing;
  const transceiver = pc.getTransceivers().find(item => item.sender === sender);
  if (transceiver?.direction === "stopped") sender = undefined;
  if (sender) {
    sender.setStreams?.(stream);
    await sender.replaceTrack(track);
    if (transceiver?.direction === "recvonly") transceiver.direction = "sendrecv";
    else if (transceiver?.direction === "inactive") transceiver.direction = "sendonly";
  } else {
    sender = pc.addTrack(track, stream);
  }
  screenAudioSenders.set(pc, sender);
  await applyAudioSenderParams(sender, SCREEN_AUDIO_SEND_PARAMS.maxBitrate);
  return sender;
}

export async function detachLocalScreenAudioTrack(
  pc: RTCPeerConnection,
  track?: MediaStreamTrack | null,
) {
  const sender = screenAudioSenders.get(pc) || pc.getSenders().find(
    (item) =>
      (track && item.track === track) ||
      (item.track?.kind === "audio" && item.track.contentHint === "music"),
  );
  if (!sender) return;
  screenAudioSenders.set(pc, sender);
  try {
    // removeTrack changes the transceiver direction while its track is present.
    pc.removeTrack(sender);
  } catch {
    /* ignore */
  }
  try {
    await sender.replaceTrack(null);
  } catch {
    /* ignore */
  }
}

export type ScreenAudioDescription = RTCSessionDescriptionInit & { screenAudioMids?: string[] };

export function localScreenAudioMids(pc: RTCPeerConnection, sdp = pc.localDescription?.sdp || "") {
  const senders = pc.getSenders().filter(sender => sender.track?.kind === "audio" &&
    (sender === screenAudioSenders.get(pc) || sender.track.contentHint === "music"));
  const mids = new Set<string>();
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.mid !== null && senders.includes(transceiver.sender)) mids.add(transceiver.mid);
  }
  // Initial offers have no assigned transceiver mids yet; SDP msid identifies the track.
  for (const section of sdp.split(/\r?\n(?=m=)/)) {
    if (!section.startsWith("m=audio ")) continue;
    const mid = /^a=mid:([^\r\n]+)/m.exec(section)?.[1];
    const ids = [...section.matchAll(/^a=msid:\S+ (\S+)/gm)].map(match => match[1]);
    if (mid && senders.some(sender => ids.includes(sender.track!.id))) mids.add(mid);
  }
  return mids;
}

/** Role metadata travels in signaling; contentHint itself is local to each peer. */
export function withScreenAudioRouting(pc: RTCPeerConnection, desc: RTCSessionDescriptionInit): ScreenAudioDescription {
  return { ...desc, screenAudioMids: [...localScreenAudioMids(pc, desc.sdp)] };
}

export async function setRemoteDescriptionWithAudioRouting(pc: RTCPeerConnection, desc: ScreenAudioDescription) {
  const previous = remoteScreenAudioMids.get(pc);
  if (Array.isArray(desc.screenAudioMids)) {
    remoteScreenAudioMids.set(pc, new Set(desc.screenAudioMids.filter(mid => typeof mid === "string")));
  } else remoteScreenAudioMids.delete(pc);
  try {
    // Store roles before setRemoteDescription, which dispatches ontrack.
    await pc.setRemoteDescription({ type: desc.type, sdp: desc.sdp });
  } catch (error) {
    if (previous) remoteScreenAudioMids.set(pc, previous);
    else remoteScreenAudioMids.delete(pc);
    throw error;
  }
}

export function remoteScreenAudioTrackIds(pc: RTCPeerConnection): ReadonlySet<string> | undefined {
  const mids = remoteScreenAudioMids.get(pc);
  if (!mids) return undefined; // Older peers still use the legacy heuristic.
  return new Set(pc.getTransceivers().filter(item => item.mid !== null && mids.has(item.mid) &&
    item.receiver.track.kind === "audio").map(item => item.receiver.track.id));
}

export function prepareCameraTrack(track: MediaStreamTrack) {
  try {
    track.contentHint = "motion";
  } catch {
    /* older browsers */
  }
}

export async function phoneCanFlipCamera() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return false;
  }
  const ua = navigator.userAgent || "";
  const coarse =
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)")?.matches;
  const mobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && Boolean(coarse));
  try {
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "videoinput",
    );
    if (cameras.length > 1) return true;
  } catch {
    /* permission not granted yet */
  }
  return mobile;
}

/** Front/back phone cameras, with fallbacks when 1080p or facingMode is rejected. */
export async function openCameraStream(facing: CameraFacing = "user") {
  const attempts: MediaStreamConstraints[] = [
    { audio: false, video: cameraVideoConstraints(facing) },
    {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    },
    { audio: false, video: { facingMode: { ideal: facing } } },
    { audio: false, video: true },
  ];
  let lastError: unknown;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        continue;
      }
      prepareCameraTrack(track);
      try {
        const width = track.getSettings().width || 0;
        if (width > 0 && width < 1280) {
          await track.applyConstraints({
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 30 },
          });
        }
      } catch {
        /* keep the mode the device actually opened */
      }
      return stream;
    } catch (error) {
      lastError = error;
      const name =
        error && typeof error === "object" && "name" in error
          ? String((error as { name?: string }).name)
          : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("camera-unavailable");
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
        .find((item) => item.receiver.track.kind === "audio" &&
          item.direction !== "stopped" && item.sender !== screenAudioSenders.get(pc) &&
          item.sender.track?.contentHint !== "music")?.sender;
    if (sender) {
      sender.setStreams?.(stream);
      await sender.replaceTrack(track);
      const transceiver = pc.getTransceivers().find(item => item.sender === sender);
      if (transceiver?.direction === "recvonly") transceiver.direction = "sendrecv";
      else if (transceiver?.direction === "inactive") transceiver.direction = "sendonly";
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
    const encoding = params.encodings[0] as RTCRtpEncodingParameters & {
      networkPriority?: RTCPriorityType;
    };
    encoding.maxBitrate = opts.maxBitrate;
    encoding.maxFramerate = opts.maxFramerate;
    encoding.scaleResolutionDownBy = opts.scaleResolutionDownBy ?? 1;
    encoding.priority = "high";
    encoding.networkPriority = "high";
    (params as RTCRtpSendParameters & {
      degradationPreference?: RTCDegradationPreference;
    }).degradationPreference = opts.maintainResolution
      ? "maintain-resolution"
      : "maintain-framerate";
    await sender.setParameters(params);
  } catch {
    /* browser may reject mid-call tweaks */
  }
}

export async function applyAudioSenderParams(
  sender: RTCRtpSender | undefined,
  maxBitrate: number = AUDIO_SEND_PARAMS.maxBitrate,
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
      await applyAudioSenderParams(
        sender,
        sender.track.contentHint === "music"
          ? SCREEN_AUDIO_SEND_PARAMS.maxBitrate
          : AUDIO_SEND_PARAMS.maxBitrate,
      );
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

function upsertFmtp(params: string, key: string, value: string) {
  const next = params.replace(/^;+/, "");
  const re = new RegExp(`${key}=[^;]*`, "i");
  if (re.test(next)) return next.replace(re, `${key}=${value}`);
  return next ? `${next};${key}=${value}` : `${key}=${value}`;
}

function patchOpusSection(section: string, screen: boolean, eol: string) {
  const bitrate = screen
    ? SCREEN_AUDIO_SEND_PARAMS.maxBitrate
    : AUDIO_SEND_PARAMS.maxBitrate;
  const pts = [...section.matchAll(/^a=rtpmap:(\d+) opus\/48000/gim)].map(
    (match) => match[1],
  );
  if (!pts.length) return section;
  let next = section;
  for (const pt of pts) {
    const tune = (params: string) => {
      let patched = upsertFmtp(params, "minptime", "10");
      patched = upsertFmtp(patched, "useinbandfec", "1");
      patched = upsertFmtp(patched, "usedtx", screen ? "0" : "1");
      patched = upsertFmtp(patched, "maxaveragebitrate", String(bitrate));
      patched = upsertFmtp(patched, "stereo", screen ? "1" : "0");
      if (screen) patched = upsertFmtp(patched, "sprop-stereo", "1");
      return patched;
    };
    const fmtp = new RegExp(`^(a=fmtp:${pt} )(.*)$`, "im");
    if (fmtp.test(next)) {
      next = next.replace(fmtp, (_line, prefix: string, params: string) => {
        return `${prefix}${tune(params)}`;
      });
      continue;
    }
    next = next.replace(
      new RegExp(`^(a=rtpmap:${pt} opus\\/48000.*)$`, "im"),
      `$1${eol}a=fmtp:${pt} ${tune("")}`,
    );
  }
  return next;
}

export function patchOpusSdp(sdp: string, screenAudioMids?: ReadonlySet<string>) {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const chunks = sdp.split(/\r?\n(?=m=)/);
  let audioIndex = 0;
  const next = chunks.map((chunk) => {
    if (!/(^|\n)m=audio /.test(chunk)) return chunk;
    const mid = /^a=mid:([^\r\n]+)/m.exec(chunk)?.[1];
    const screen = screenAudioMids ? Boolean(mid && screenAudioMids.has(mid)) : audioIndex > 0;
    audioIndex += 1;
    return patchOpusSection(chunk, screen, eol);
  });
  return next.join(eol);
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
    if (desc.sdp) desc.sdp = patchOpusSdp(desc.sdp, localScreenAudioMids(pc, desc.sdp));
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
const videoStreams = new WeakMap<MediaStreamTrack, MediaStream>();

function streamForVideoTrack(track: MediaStreamTrack) {
  let stream = videoStreams.get(track);
  if (!stream) {
    stream = new MediaStream([track]);
    videoStreams.set(track, stream);
  }
  return stream;
}

export function pickCameraStream(stream: MediaStream | null) {
  if (!stream) return null;
  const live = liveVideoTracks(stream);
  const camera = live.find((track) => !videoTrackLooksLikeScreen(track));
  if (!camera) return null;
  return streamForVideoTrack(camera);
}

/** Prefer a screen track when a stream carries both camera and screen. */
export function pickScreenStream(stream: MediaStream | null) {
  if (!stream) return null;
  const live = liveVideoTracks(stream);
  const screen = live.find((track) => videoTrackLooksLikeScreen(track));
  if (!screen) return null;
  return streamForVideoTrack(screen);
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

/** Explicit signaling roles take precedence; hints/order support older peers. */
export function splitCallAudioTracks(
  tracks: MediaStreamTrack[],
  screenIds: Set<string>,
  explicitScreenIds?: ReadonlySet<string>,
) {
  const live = tracks.filter((track) => track.readyState === "live");
  if (explicitScreenIds) screenIds.clear();
  for (const track of live) {
    if (explicitScreenIds ? explicitScreenIds.has(track.id) : track.contentHint === "music") {
      screenIds.add(track.id);
    }
  }
  for (const id of [...screenIds]) {
    if (!live.some((track) => track.id === id)) screenIds.delete(id);
  }
  const unmarked = live.filter((track) => !screenIds.has(track.id));
  if (!explicitScreenIds && unmarked.length > 1) {
    for (const extra of unmarked.slice(1)) screenIds.add(extra.id);
  }
  return {
    voice: live.filter((track) => !screenIds.has(track.id)),
    screen: live.filter((track) => screenIds.has(track.id)),
  };
}

/**
 * Remote receivers do not get contentHint. When both camera and screen are
 * live, the later track is the screen share (it is published after the camera).
 */
export function noteRemotePresentation(stream: MediaStream, sharing: boolean) {
  const live = liveVideoTracks(stream);
  if (!sharing || live.length < 2) return;
  const known = live.find((track) => videoTrackLooksLikeScreen(track));
  const screen = known || live[live.length - 1];
  prepareScreenTrack(screen);
  for (const track of live) {
    if (track !== screen) prepareCameraTrack(track);
  }
}
