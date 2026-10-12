"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopMedia } from "@/hooks/useDesktopMedia";
import { getDesktopMediaRuntime } from "@/lib/desktopMedia";
import type { Socket } from "socket.io-client";
import type { CallMode, IncomingCall } from "@/lib/types";
import { getClientIceServers } from "@/lib/iceServers";
import {
  configureSpeakingAnalyser,
  createSpeakingSamples,
  pickSpeakingTrack,
  speakingLevelFromAnalyser,
  SPEAKING_HOLD_MS,
  SPEAKING_THRESHOLD,
  startSpeakingTicker,
  type SpeakingSamples,
} from "@/lib/speakingMeter";
import {
  closeNotifyByTag,
  getNotifyPermission,
  showIncomingCallNotify,
} from "@/lib/notify";
import {
  applyAudioSenders,
  applyVideoSenderParams,
  attachLocalScreenAudioTrack,
  attachLocalVideoTrackByHint,
  callNetworkLevel,
  CAMERA_SEND_PARAMS,
  captureScreenShare,
  detachLocalScreenAudioTrack,
  detachLocalVideoTrackByHint,
  emptyCallStatsCursor,
  noteRemotePresentation,
  openCameraStream,
  optimizePeerConnection,
  phoneCanFlipCamera,
  prepareCameraTrack,
  prepareScreenTrack,
  readCallNetworkSample,
  readInboundFlow,
  replaceAudioSenders,
  SCREEN_SEND_PARAMS,
  setLocalDescriptionTuned,
  setRemoteDescriptionWithAudioRouting,
  remoteScreenAudioTrackIds,
  withScreenAudioRouting,
  splitCallAudioTracks,
  videoQualityForCall,
  withReplacedAudioTrack,
  type CallNetworkLevel,
  type CallStatsCursor,
  type CameraFacing,
} from "@/lib/webrtcMedia";
import {
  captureFilteredMic,
  getNeuralNoiseEnabled,
  getNoiseFilterPref,
  setNeuralNoiseEnabled,
  setMicEnabled,
  stopNoiseFilter,
  type NoiseFilterKind,
  type NoiseFilterSession,
} from "@/lib/noiseFilter";
import {
  applyAudioOutput,
  subscribeVoiceSettings,
  type VoiceSettingsChange,
} from "@/lib/mediaDevices";
import { registerScreenAudio, unregisterScreenAudio } from "@/lib/screenAudio";
import {
  clearMediaResume,
  isPageUnloading,
  peekMediaResume,
  registerMediaResumePersist,
  saveMediaResume,
  setLiveMediaSession,
  type MediaResume,
} from "@/lib/mediaResume";

type UseCallOptions = {
  socket: Socket | null;
  selfId?: string;
  token?: string | null;
  onLog?: (chatId: string, text: string) => void;
};

type CallMediaState = {
  cameraOff: boolean;
  sharingScreen: boolean;
  revision: number;
};

const RING_TIMEOUT_MS = 35_000;
const ICE_RESTART_DELAY_MS = 5_000;
const MAX_ICE_RESTARTS = 3;
/** Stats interval is 2s → 4 ticks ≈ 8s without inbound media. */
const MEDIA_STALL_TICKS = 4;
/** Restart streak window — excess restarts within it trigger the relay
 * fallback even when markConnected resets the per-connection counter. */
const RESTART_STREAK_WINDOW_MS = 60_000;
const CALL_HANGUP_KEY = "pulse-call-hungup";

function callPcAlive(pc: RTCPeerConnection | null) {
  if (!pc) return false;
  const conn = pc.connectionState;
  const ice = pc.iceConnectionState;
  return (
    conn === "connected" ||
    conn === "connecting" ||
    ice === "connected" ||
    ice === "completed" ||
    ice === "checking"
  );
}

function markCallHungUp(callId: string | null) {
  if (!callId || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(CALL_HANGUP_KEY, callId);
  } catch {
    /* private mode */
  }
}

function consumeCallHungUp(callId: string) {
  if (typeof sessionStorage === "undefined") return false;
  try {
    if (sessionStorage.getItem(CALL_HANGUP_KEY) !== callId) return false;
    sessionStorage.removeItem(CALL_HANGUP_KEY);
    return true;
  } catch {
    return false;
  }
}

function formatDuration(totalSeconds: number) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function useCall(options: UseCallOptions) {
  const desktop = useDesktopMedia({ selfId: options.selfId, token: options.token ?? undefined });
  const native = useBrowserCall(getDesktopMediaRuntime() ? { socket: null } : options);
  const silentUiAudio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!desktop) return;
    setLiveMediaSession("call", Boolean(desktop.call.active || desktop.call.incoming));
    return () => setLiveMediaSession("call", false);
  }, [desktop]);
  // Playback belongs to the owner as well: reloading an <audio> in the UI
  // must neither silence the call nor play its audio a second time.
  return desktop ? { ...desktop.call, remoteAudioRef: silentUiAudio } : native;
}

export function useBrowserCall({ socket, selfId, token = null, onLog }: UseCallOptions) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const tokenRef = useRef(token);
  const sessionTokenRef = useRef(token);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraWasOffRef = useRef(false);
  const localCameraOffRef = useRef(true);
  const localSharingScreenRef = useRef(false);
  const localMediaRevisionRef = useRef(0);
  const remoteMediaRevisionRef = useRef(-1);
  const mediaBusyRef = useRef(false);
  const noiseFilterRef = useRef<NoiseFilterSession | null>(null);
  const voiceSettingsUpdateRef = useRef<Promise<void>>(Promise.resolve());
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<{
    peerId: string;
    chatId: string;
    mode: CallMode;
    callId: string;
  } | null>(null);
  const callIdRef = useRef<string | null>(null);
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteReadyRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  const resumedConnectedAtRef = useRef<number | null>(null);
  const resumeControlsRef = useRef<Extract<MediaResume, { kind: "call" }> | null>(null);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerReturnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceRestartsRef = useRef(0);
  const relayOnlyRef = useRef(false);
  const relayTriedRef = useRef(false);
  const lastInboundBytesRef = useRef(-1);
  const lastInboundPacketsRef = useRef(-1);
  const stallTicksRef = useRef(0);
  const stallRecoveryRef = useRef(false);
  const restartStreakRef = useRef({ count: 0, since: 0 });
  const busyRef = useRef(false);
  const outboundRef = useRef(false);
  const acceptReadyRef = useRef(false);
  const peerLeftRef = useRef(false);
  const restartIceRef = useRef<(peerId: string) => Promise<void>>(async () => {});

  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [active, setActive] = useState<{
    peerId: string;
    peerName: string;
    mode: CallMode;
    chatId: string;
    outbound: boolean;
    callId: string;
  } | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [noiseFilterEnabled, setNoiseFilterEnabled] = useState(
    getNoiseFilterPref,
  );
  const [noiseFilterKind, setNoiseFilterKind] =
    useState<NoiseFilterKind>("browser");
  const [remoteSharingScreen, setRemoteSharingScreen] = useState(false);
  const [remoteCameraOff, setRemoteCameraOff] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [status, setStatus] = useState("");
  const [duration, setDuration] = useState(0);
  const [networkQuality, setNetworkQuality] = useState<{
    rttMs: number;
    level: "good" | "ok" | "poor";
  } | null>(null);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakTimerRef = useRef<(() => void) | null>(null);
  const mediaRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastMediaRequestRef = useRef({ revision: -1, at: 0 });
  const videoQualityKeyRef = useRef<Record<string, string>>({});
  const cameraFacingRef = useRef<CameraFacing>("user");
  const remoteSharingScreenRef = useRef(false);
  const remoteScreenAudioIdsRef = useRef(new Set<string>());
  const screenAudioElRef = useRef<HTMLAudioElement | null>(null);
  const [canFlipCamera, setCanFlipCamera] = useState(false);
  const statsCursorRef = useRef<CallStatsCursor>(emptyCallStatsCursor());
  const lastNetworkRef = useRef<{
    rttMs: number;
    level: CallNetworkLevel;
  } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const localSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const localAnalyserTrackIdRef = useRef<string | null>(null);
  const remoteAnalyserTrackIdRef = useRef<string | null>(null);
  const localSpeakHoldUntilRef = useRef(0);
  const remoteSpeakHoldUntilRef = useRef(0);

  const emitCurrentMediaState = useCallback(
    (
      nextCameraOff = localCameraOffRef.current,
      nextSharingScreen = localSharingScreenRef.current,
    ) => {
      localCameraOffRef.current = nextCameraOff;
      localSharingScreenRef.current = nextSharingScreen;
      const peer = peerRef.current;
      const callId = callIdRef.current;
      if (!socket || !peer || !callId) return;
      const revision = ++localMediaRevisionRef.current;
      socket.emit("call:signal", {
        callId,
        toUserId: peer.peerId,
        type: "media-state",
        data: {
          cameraOff: nextCameraOff,
          sharingScreen: nextSharingScreen,
          revision,
        } satisfies CallMediaState,
      });
    },
    [socket],
  );

  const clearTimers = useCallback(() => {
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (cleanupTimerRef.current) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    if (peerReturnTimerRef.current) {
      clearTimeout(peerReturnTimerRef.current);
      peerReturnTimerRef.current = null;
    }
    if (iceRestartTimerRef.current) {
      clearTimeout(iceRestartTimerRef.current);
      iceRestartTimerRef.current = null;
    }
    if (mediaRecoveryTimerRef.current) {
      clearTimeout(mediaRecoveryTimerRef.current);
      mediaRecoveryTimerRef.current = null;
    }
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (speakTimerRef.current) {
      speakTimerRef.current();
      speakTimerRef.current = null;
    }
    try {
      void audioCtxRef.current?.close();
    } catch {
      /* ignore */
    }
    audioCtxRef.current = null;
    localAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    localSourceRef.current = null;
    remoteSourceRef.current = null;
    localAnalyserTrackIdRef.current = null;
    remoteAnalyserTrackIdRef.current = null;
    localSpeakHoldUntilRef.current = 0;
    remoteSpeakHoldUntilRef.current = 0;
    setNetworkQuality(null);
    setLocalSpeaking(false);
    setRemoteSpeaking(false);
    videoQualityKeyRef.current = {};
    statsCursorRef.current = emptyCallStatsCursor();
    lastNetworkRef.current = null;
  }, []);

  const ensureScreenAudioEl = useCallback(() => {
    const existing = screenAudioElRef.current;
    if (existing) return existing;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.hidden = true;
    audio.setAttribute("playsinline", "");
    document.body.appendChild(audio);
    screenAudioElRef.current = audio;
    return audio;
  }, []);

  const stopScreenAudioEl = useCallback(() => {
    const audio = screenAudioElRef.current;
    if (!audio) return;
    unregisterScreenAudio(audio);
    audio.srcObject = null;
    audio.remove();
    screenAudioElRef.current = null;
  }, []);

  const publishRemoteStream = useCallback(() => {
    const stream = remoteStreamRef.current;
    if (!stream) {
      setRemoteStream(null);
      stopScreenAudioEl();
      return;
    }
    const liveTracks = stream
      .getTracks()
      .filter((track) => track.readyState === "live");
    const audioTracks = liveTracks.filter((track) => track.kind === "audio");
    const videoTracks = liveTracks.filter((track) => track.kind === "video");
    const audible = videoTracks.filter((track) => !track.muted);
    const chosenVideos = audible.length ? audible : videoTracks.slice(-1);
    const { voice, screen } = splitCallAudioTracks(
      audioTracks,
      remoteScreenAudioIdsRef.current,
      pcRef.current ? remoteScreenAudioTrackIds(pcRef.current) : undefined,
    );
    const clone = new MediaStream([...voice, ...chosenVideos]);
    noteRemotePresentation(clone, chosenVideos.length > 1);
    setRemoteStream(clone);
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = new MediaStream(voice);
      remoteAudioRef.current.muted = deafenedRef.current;
      void applyAudioOutput(remoteAudioRef.current);
      if (!deafenedRef.current && voice.length) {
        void remoteAudioRef.current.play().catch(() => undefined);
      }
    }
    if (!screen.length) {
      const audio = screenAudioElRef.current;
      if (audio) {
        unregisterScreenAudio(audio);
        audio.srcObject = null;
      }
      return;
    }
    const screenAudio = ensureScreenAudioEl();
    const currentIds = (screenAudio.srcObject as MediaStream | null)
      ?.getAudioTracks()
      .map((track) => track.id)
      .join("|");
    const nextIds = screen.map((track) => track.id).join("|");
    if (currentIds !== nextIds) {
      screenAudio.srcObject = new MediaStream(screen);
    }
    screenAudio.muted = deafenedRef.current;
    registerScreenAudio(screenAudio, peerRef.current?.peerId || "remote");
    void applyAudioOutput(screenAudio);
    if (!deafenedRef.current) {
      void screenAudio.play().catch(() => undefined);
    }
  }, [ensureScreenAudioEl, stopScreenAudioEl]);

  useEffect(() => {
    remoteSharingScreenRef.current = remoteSharingScreen;
    publishRemoteStream();
  }, [publishRemoteStream, remoteSharingScreen]);

  const adaptVideoQuality = useCallback(
    async (level: CallNetworkLevel) => {
      const pc = pcRef.current;
      if (!pc) return;
      const hidden =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      const senders = pc.getSenders();

      const applyKind = async (
        kind: "camera" | "screen",
        sender: RTCRtpSender | undefined,
      ) => {
        if (!sender?.track) return;
        const next = videoQualityForCall(kind, level, hidden);
        const key = `${next.label}:${hidden ? "hid" : "vis"}`;
        if (videoQualityKeyRef.current[kind] === key) return;
        videoQualityKeyRef.current[kind] = key;
        await applyVideoSenderParams(sender, {
          maxBitrate: next.maxBitrate,
          maxFramerate: next.maxFramerate,
          scaleResolutionDownBy: next.scale,
          maintainResolution: kind === "screen",
        });
        if (!hidden && next.label !== "1080" && next.label !== "720") {
          setStatus(
            kind === "screen"
              ? `Сеть слабая · экран ${next.label}p`
              : `Сеть слабая · камера ${next.label}p`,
          );
        }
      };

      const screenSender = senders.find(
        (item) =>
          item.track &&
          item.track === screenTrackRef.current,
      );
      const cameraSender = senders.find(
        (item) =>
          item.track &&
          item.track === cameraTrackRef.current,
      );
      if (screenSender) await applyKind("screen", screenSender);
      if (cameraSender) await applyKind("camera", cameraSender);
    },
    [],
  );

  const startCallMonitors = useCallback(() => {
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    statsTimerRef.current = setInterval(() => {
      const pc = pcRef.current;
      if (!pc) return;
      if (pc.connectionState !== "connected") {
        setNetworkQuality(null);
        lastNetworkRef.current = null;
        return;
      }
      void pc.getStats().then((report) => {
        if (pcRef.current !== pc || pc.connectionState !== "connected") return;
        // Media-flow watchdog: ICE can stay "connected" while media stalls
        // (one-way audio, frozen NAT mapping). Force ICE restart when no
        // inbound bytes arrive for several ticks.
        if (
          pc.connectionState === "connected" &&
          document.visibilityState !== "hidden"
        ) {
          const flow = readInboundFlow(report);
          // DTX silence sends tiny comfort-noise packets — require BOTH
          // bytes and packets to be frozen before counting a stall.
          if (flow.bytes > 0 || flow.packets > 0) {
            const grew =
              (lastInboundBytesRef.current >= 0 &&
                flow.bytes > lastInboundBytesRef.current) ||
              (lastInboundPacketsRef.current >= 0 &&
                flow.packets > lastInboundPacketsRef.current);
            if (stallRecoveryRef.current) {
              if (grew) stallRecoveryRef.current = false;
            } else if (grew || lastInboundBytesRef.current < 0) {
              stallTicksRef.current = 0;
            } else {
              stallTicksRef.current += 1;
              if (
                stallTicksRef.current >= MEDIA_STALL_TICKS &&
                !makingOfferRef.current &&
                !iceRestartTimerRef.current
              ) {
                stallTicksRef.current = 0;
                const peerId = peerRef.current?.peerId;
                if (peerId) void restartIceRef.current(peerId);
              }
            }
            lastInboundBytesRef.current = flow.bytes;
            lastInboundPacketsRef.current = flow.packets;
          }
        }

        const sample = readCallNetworkSample(report, statsCursorRef.current);
        if (!sample) return;
        const level = callNetworkLevel(sample);
        const rttMs = sample.rttMs;
        const previous = lastNetworkRef.current;
        if (!previous || previous.rttMs !== rttMs || previous.level !== level) {
          lastNetworkRef.current = { rttMs, level };
          setNetworkQuality({ rttMs, level });
        }
        void adaptVideoQuality(level);
      }).catch(() => {
        if (pcRef.current === pc) setNetworkQuality(null);
      });
    }, 2000);

    if (speakTimerRef.current) speakTimerRef.current();
    const localSamples = createSpeakingSamples();
    const remoteSamples = createSpeakingSamples();
    speakTimerRef.current = startSpeakingTicker(() => {
      const ensureAnalyser = (
        track: MediaStreamTrack | null,
        sourceRef: typeof localSourceRef,
        analyserRef: typeof localAnalyserRef,
        boundTrackIdRef: typeof localAnalyserTrackIdRef,
        samples: SpeakingSamples,
      ) => {
        if (!track) return 0;
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
        const ctx = audioCtxRef.current;
        if (ctx.state === "suspended") void ctx.resume();
        if (
          boundTrackIdRef.current !== track.id ||
          !analyserRef.current ||
          !sourceRef.current
        ) {
          try {
            sourceRef.current?.disconnect();
          } catch {
            /* ignore */
          }
          sourceRef.current = ctx.createMediaStreamSource(
            new MediaStream([track]),
          );
          analyserRef.current = ctx.createAnalyser();
          configureSpeakingAnalyser(analyserRef.current);
          sourceRef.current.connect(analyserRef.current);
          boundTrackIdRef.current = track.id;
        }
        return speakingLevelFromAnalyser(analyserRef.current, samples);
      };

      try {
        const localTrack = mutedRef.current
          ? null
          : pickSpeakingTrack(
              noiseFilterRef.current?.sourceTrack,
              localStreamRef.current,
            );
        const remoteTrack = pickSpeakingTrack(null, remoteStreamRef.current);
        const localLevel = ensureAnalyser(
          localTrack,
          localSourceRef,
          localAnalyserRef,
          localAnalyserTrackIdRef,
          localSamples,
        );
        const remoteLevel = ensureAnalyser(
          remoteTrack,
          remoteSourceRef,
          remoteAnalyserRef,
          remoteAnalyserTrackIdRef,
          remoteSamples,
        );
        const now = Date.now();
        if (localLevel > SPEAKING_THRESHOLD) {
          localSpeakHoldUntilRef.current = now + SPEAKING_HOLD_MS;
        }
        if (remoteLevel > SPEAKING_THRESHOLD) {
          remoteSpeakHoldUntilRef.current = now + SPEAKING_HOLD_MS;
        }
        setLocalSpeaking(now < localSpeakHoldUntilRef.current);
        setRemoteSpeaking(now < remoteSpeakHoldUntilRef.current);
      } catch {
        setLocalSpeaking(false);
        setRemoteSpeaking(false);
      }
    });
  }, [adaptVideoQuality]);

  const publishLocalVideos = useCallback(() => {
    const audioTracks = [
      ...(localStreamRef.current?.getAudioTracks() || []),
      screenAudioTrackRef.current,
    ].filter(
      (track): track is MediaStreamTrack =>
        Boolean(track && track.readyState === "live"),
    );
    const uniqueAudio = [
      ...new Map(audioTracks.map((track) => [track.id, track])).values(),
    ];
    const videos = [cameraTrackRef.current, screenTrackRef.current].filter(
      (track): track is MediaStreamTrack =>
        Boolean(track && track.readyState === "live"),
    );
    const media = new MediaStream([...uniqueAudio, ...videos]);
    localStreamRef.current = media;
    setLocalStream(media);
    return media;
  }, []);

  const stopScreenShare = useCallback(() => {
    const wasSharing = Boolean(screenTrackRef.current || screenAudioTrackRef.current);
    const peer = peerRef.current;
    const callId = callIdRef.current;
    const screenAudio = screenAudioTrackRef.current;

    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    screenAudioTrackRef.current = null;
    setSharingScreen(false);
    localSharingScreenRef.current = false;

    if (wasSharing && socket && peer && callId) {
      socket.emit("call:signal", {
        callId,
        toUserId: peer.peerId,
        type: "screen-off",
      });
    }

    const pc = pcRef.current;
    const camera = cameraTrackRef.current;
    const cameraLive =
      Boolean(camera) &&
      camera?.readyState === "live" &&
      !cameraWasOffRef.current;

    void (async () => {
      if (pc) {
        await detachLocalVideoTrackByHint(pc, "detail");
        await detachLocalScreenAudioTrack(pc, screenAudio);
      }
      screenAudio?.stop();
    })();

    const media = publishLocalVideos();
    setCameraOff(!cameraLive);
    emitCurrentMediaState(!cameraLive, false);
    if (wasSharing) {
      setStatus(cameraLive ? "На линии" : "Демонстрация экрана завершена");
    }
    void media;
  }, [socket, emitCurrentMediaState, publishLocalVideos]);

  const cleanup = useCallback(() => {
    clearTimers();
    stopScreenShare();
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    stopScreenAudioEl();
    remoteScreenAudioIdsRef.current.clear();
    const filter = noiseFilterRef.current;
    noiseFilterRef.current = null;
    void stopNoiseFilter(filter);
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraTrackRef.current?.stop();
    cameraTrackRef.current = null;
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setActive(null);
    setIncoming(null);
    setStatus("");
    setMuted(false);
    setDeafened(false);
    deafenedRef.current = false;
    setCameraOff(true);
    setSharingScreen(false);
    mediaBusyRef.current = false;
    setMediaBusy(false);
    setRemoteSharingScreen(false);
    setRemoteCameraOff(true);
    setLocalSpeaking(false);
    setRemoteSpeaking(false);
    setMinimized(false);
    setDuration(0);
    connectedAtRef.current = null;
    resumedConnectedAtRef.current = null;
    resumeControlsRef.current = null;
    peerRef.current = null;
    callIdRef.current = null;
    pendingOfferRef.current = null;
    pendingIceRef.current = [];
    remoteReadyRef.current = false;
    makingOfferRef.current = false;
    busyRef.current = false;
    outboundRef.current = false;
    acceptReadyRef.current = false;
    peerLeftRef.current = false;
    iceRestartsRef.current = 0;
    relayOnlyRef.current = false;
    relayTriedRef.current = false;
    stallTicksRef.current = 0;
    stallRecoveryRef.current = false;
    lastInboundBytesRef.current = -1;
    lastInboundPacketsRef.current = -1;
    restartStreakRef.current = { count: 0, since: 0 };
    cameraWasOffRef.current = true;
    localCameraOffRef.current = true;
    localSharingScreenRef.current = false;
    localMediaRevisionRef.current = 0;
    remoteMediaRevisionRef.current = -1;
    lastMediaRequestRef.current = { revision: -1, at: 0 };
    remoteSharingScreenRef.current = false;
    cameraFacingRef.current = "user";
  }, [clearTimers, stopScreenAudioEl, stopScreenShare]);

  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;

  const scheduleCleanup = useCallback(
    (delay: number) => {
      if (cleanupTimerRef.current) clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = setTimeout(() => cleanup(), delay);
    },
    [cleanup],
  );

  const dropRemotePeer = useCallback(() => {
    peerLeftRef.current = true;
    if (iceRestartTimerRef.current) {
      clearTimeout(iceRestartTimerRef.current);
      iceRestartTimerRef.current = null;
    }
    try {
      pcRef.current?.close();
    } catch {
      /* ignore */
    }
    pcRef.current = null;
    remoteStreamRef.current = null;
    setRemoteStream(null);
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    stopScreenAudioEl();
    remoteScreenAudioIdsRef.current.clear();
    remoteSharingScreenRef.current = false;
    pendingIceRef.current = [];
    pendingOfferRef.current = null;
    remoteReadyRef.current = false;
    makingOfferRef.current = false;
    acceptReadyRef.current = false;
    iceRestartsRef.current = 0;
    restartStreakRef.current = { count: 0, since: 0 };
    setRemoteSharingScreen(false);
    setRemoteCameraOff(true);
    setRemoteSpeaking(false);
    setStatus("Собеседник вышел");
    scheduleCleanup(1200);
  }, [scheduleCleanup, stopScreenAudioEl]);

  const markConnected = useCallback(() => {
    if (peerReturnTimerRef.current) {
      clearTimeout(peerReturnTimerRef.current);
      peerReturnTimerRef.current = null;
    }
    setStatus("На линии");
    iceRestartsRef.current = 0;
    stallTicksRef.current = 0;
    stallRecoveryRef.current = false;
    lastInboundBytesRef.current = -1;
    lastInboundPacketsRef.current = -1;
    startCallMonitors();
    if (connectedAtRef.current) return;
    connectedAtRef.current = resumedConnectedAtRef.current || Date.now();
    resumedConnectedAtRef.current = null;
    setDuration(Math.floor((Date.now() - connectedAtRef.current) / 1000));
    if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    durationTimerRef.current = setInterval(() => {
      if (!connectedAtRef.current) return;
      setDuration(Math.floor((Date.now() - connectedAtRef.current) / 1000));
    }, 1000);
  }, [startCallMonitors]);

  const emitSignal = useCallback(
    (
      toUserId: string,
      type:
        | "offer"
        | "answer"
        | "ice"
        | "accept"
        | "reject"
        | "end"
        | "screen-on"
        | "screen-off"
        | "camera-on"
        | "camera-off"
        | "media-request"
        | "media-state",
      data?: unknown,
    ) => {
      const callId = callIdRef.current;
      if (!socket || !callId) return;
      socket.emit("call:signal", {
        callId,
        toUserId,
        type,
        data: (type === "offer" || type === "answer") && pcRef.current && data
          ? withScreenAudioRouting(pcRef.current, data as RTCSessionDescriptionInit) : data,
      });
    },
    [socket],
  );

  const scheduleRemoteMediaRecovery = useCallback(
    (peerId: string, revision: number) => {
      if (mediaRecoveryTimerRef.current) {
        clearTimeout(mediaRecoveryTimerRef.current);
      }
      mediaRecoveryTimerRef.current = setTimeout(() => {
        mediaRecoveryTimerRef.current = null;
        void (async () => {
          const pc = pcRef.current;
          if (!pc) return;
          let flowing = false;
          for (const receiver of pc
            .getReceivers()
            .filter((item) => item.track.kind === "video")) {
            try {
              const stats = await receiver.getStats();
              stats.forEach((report) => {
                if (
                  report.type === "inbound-rtp" &&
                  (Number(report.bytesReceived || 0) > 0 ||
                    Number(report.framesDecoded || 0) > 0)
                ) {
                  flowing = true;
                }
              });
            } catch {
              /* receiver stats are optional on older mobile browsers */
            }
          }
          if (flowing) return;
          const last = lastMediaRequestRef.current;
          if (last.revision === revision && Date.now() - last.at < 12_000) {
            return;
          }
          lastMediaRequestRef.current = { revision, at: Date.now() };
          emitSignal(peerId, "media-request");
        })();
      }, 1800);
    },
    [emitSignal],
  );

  const flushIce = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const endAndCleanup = useCallback(
    (delay: number) => {
      const peer = peerRef.current;
      if (peer) emitSignal(peer.peerId, "end");
      scheduleCleanup(delay);
    },
    [emitSignal, scheduleCleanup],
  );

  const ensureIceServers = useCallback(async () => {
    if (iceServersRef.current.length) return iceServersRef.current;
    const servers = await getClientIceServers(tokenRef.current);
    iceServersRef.current = servers;
    return servers;
  }, []);

  const ensurePc = useCallback(
    (peerId: string) => {
      if (pcRef.current) return pcRef.current;
      const turnOnly = iceServersRef.current.filter((server) => {
        const urls = Array.isArray(server.urls)
          ? server.urls
          : [server.urls || ""];
        return urls.some(
          (url) =>
            String(url).startsWith("turn") ||
            String(url).startsWith("turns"),
        );
      });
      const iceServers =
        relayOnlyRef.current && turnOnly.length
          ? turnOnly
          : iceServersRef.current;
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: relayOnlyRef.current ? "relay" : "all",
        iceCandidatePoolSize: 4,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      });

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        // Socket.IO JSON needs a plain object — RTCIceCandidate itself drops fields.
        emitSignal(peerId, "ice", event.candidate.toJSON());
      };

      pc.onnegotiationneeded = () => {
        // Only renegotiate after the initial offer/answer (e.g. camera on).
        if (makingOfferRef.current) return;
        if (!callIdRef.current || !acceptReadyRef.current) return;
        if (!connectedAtRef.current) return;
        void (async () => {
          if (makingOfferRef.current || pcRef.current !== pc) return;
          makingOfferRef.current = true;
          try {
            optimizePeerConnection(pc);
            const offer = await pc.createOffer();
            if (pcRef.current !== pc || !callIdRef.current) return;
            await setLocalDescriptionTuned(pc, offer);
            emitSignal(peerId, "offer", {
              type: offer.type,
              sdp: offer.sdp,
            });
          } catch {
            /* glare / closed pc */
          } finally {
            makingOfferRef.current = false;
          }
        })();
      };

      pc.ontrack = (event) => {
        if (!remoteStreamRef.current) {
          remoteStreamRef.current = new MediaStream();
        }
        const stream = remoteStreamRef.current;
        if (!stream.getTrackById(event.track.id)) {
          stream.addTrack(event.track);
        }
        event.track.onended = () => {
          try {
            stream.removeTrack(event.track);
          } catch {
            /* ignore */
          }
          publishRemoteStream();
        };
        event.track.onmute = publishRemoteStream;
        event.track.onunmute = publishRemoteStream;
        publishRemoteStream();
      };

      pc.onconnectionstatechange = () => {
        if (pcRef.current !== pc || peerLeftRef.current) return;
        const state = pc.connectionState;
        if (state === "connected") markConnected();
        if (state === "connecting") setStatus("Соединение…");
        if (state === "disconnected") {
          setStatus("Связь нестабильна…");
          if (iceRestartTimerRef.current) {
            clearTimeout(iceRestartTimerRef.current);
          }
          iceRestartTimerRef.current = setTimeout(() => {
            if (
              pcRef.current === pc &&
              !peerLeftRef.current &&
              (pc.connectionState === "disconnected" ||
                pc.connectionState === "failed")
            ) {
              void restartIceRef.current(peerId);
            }
          }, ICE_RESTART_DELAY_MS);
        }
        if (state === "failed") {
          void restartIceRef.current(peerId);
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
        ) {
          markConnected();
        }
      };

      pcRef.current = pc;
      remoteReadyRef.current = false;
      return pc;
    },
    [emitSignal, markConnected, publishRemoteStream],
  );

  const prepareResumeControls = useCallback((peerId: string, chatId: string, callId?: string) => {
    if (localStreamRef.current) return;
    const saved = peekMediaResume();
    if (saved?.kind !== "call" || saved.peerId !== peerId || saved.chatId !== chatId ||
      (callId && saved.callId && saved.callId !== callId)) return;
    resumeControlsRef.current = saved;
    resumedConnectedAtRef.current = saved.connectedAt || null;
    mutedRef.current = saved.muted;
    deafenedRef.current = Boolean(saved.deafened);
    setMuted(saved.muted);
    setDeafened(Boolean(saved.deafened));
    setCameraOff(saved.cameraOff);
  }, []);

  const getMedia = useCallback(async (_mode: CallMode) => {
    const saved = resumeControlsRef.current;
    const { filter, stream } = await captureFilteredMic();
    // Apply mute BEFORE publishing any track: reload must never expose audio
    // from a microphone that the user had muted.
    setMicEnabled(stream, !mutedRef.current, filter.sourceTrack);
    noiseFilterRef.current = filter;
    setNoiseFilterEnabled(getNeuralNoiseEnabled());
    setNoiseFilterKind(filter.kind);
    setCameraOff(true);
    localCameraOffRef.current = true;
    localSharingScreenRef.current = false;
    cameraWasOffRef.current = true;
    cameraTrackRef.current = null;
    localStreamRef.current = stream;
    if (saved && !saved.cameraOff) {
      try {
        const camera = await openCameraStream(cameraFacingRef.current);
        const track = camera.getVideoTracks()[0];
        if (track) {
          prepareCameraTrack(track);
          cameraTrackRef.current = track;
          stream.addTrack(track);
          cameraWasOffRef.current = false;
          localCameraOffRef.current = false;
          setCameraOff(false);
          track.onended = () => {
            if (cameraTrackRef.current !== track) return;
            cameraTrackRef.current = null;
            cameraWasOffRef.current = true;
            localCameraOffRef.current = true;
            setCameraOff(true);
            publishLocalVideos();
          };
        }
      } catch { setStatus("Нет доступа к камере"); }
    }
    resumeControlsRef.current = null;
    setLocalStream(stream);
    return stream;
  }, [publishLocalVideos]);

  const answerRemoteOffer = useCallback(
    async (peerId: string, offer: RTCSessionDescriptionInit) => {
      const attachLocal = (pc: RTCPeerConnection) => {
        const stream = localStreamRef.current;
        stream?.getTracks().forEach((track) => {
          if (!pc.getSenders().some((sender) => sender.track === track)) {
            pc.addTrack(track, stream);
          }
        });
        void applyAudioSenders([pc]);
      };
      const tryAnswer = async (pc: RTCPeerConnection) => {
        if (pc.signalingState === "have-local-offer") {
          await pc.setLocalDescription({ type: "rollback" });
        }
        await setRemoteDescriptionWithAudioRouting(pc, offer);
        publishRemoteStream();
        remoteReadyRef.current = true;
        optimizePeerConnection(pc);
        const answer = await pc.createAnswer();
        await setLocalDescriptionTuned(pc, answer);
        void applyAudioSenders([pc]);
        emitSignal(peerId, "answer", {
          type: answer.type,
          sdp: answer.sdp,
        });
        await flushIce(pc);
      };
      try {
        const pc = ensurePc(peerId);
        attachLocal(pc);
        await tryAnswer(pc);
      } catch {
        if (pcRef.current) {
          try {
            pcRef.current.close();
          } catch {
            /* ignore */
          }
          pcRef.current = null;
        }
        pendingIceRef.current = [];
        remoteReadyRef.current = false;
        const fresh = ensurePc(peerId);
        attachLocal(fresh);
        await tryAnswer(fresh);
      }
    },
    [ensurePc, flushIce, emitSignal, publishRemoteStream],
  );

  const createOffer = useCallback(
    async (
      peerId: string,
      mode: CallMode,
      opts?: { resetPc?: boolean },
    ) => {
      if (opts?.resetPc && pcRef.current) {
        try {
          pcRef.current.close();
        } catch {
          /* ignore */
        }
        pcRef.current = null;
        pendingOfferRef.current = null;
        pendingIceRef.current = [];
        remoteReadyRef.current = false;
        makingOfferRef.current = false;
      }
      const activeCallId = callIdRef.current;
      const hadLocal = Boolean(localStreamRef.current);
      const stream =
        localStreamRef.current || (await getMedia(mode));
      if (!activeCallId || callIdRef.current !== activeCallId) {
        if (!hadLocal) {
          const filter = noiseFilterRef.current;
          noiseFilterRef.current = null;
          void stopNoiseFilter(filter);
          stream.getTracks().forEach((track) => track.stop());
          if (localStreamRef.current === stream) {
            localStreamRef.current = null;
            cameraTrackRef.current = null;
            setLocalStream(null);
          }
        }
        return;
      }
      const pc = ensurePc(peerId);
      stream.getTracks().forEach((track) => {
        if (!pc.getSenders().some((sender) => sender.track === track)) {
          pc.addTrack(track, stream);
        }
      });
      void applyAudioSenders([pc]);
      makingOfferRef.current = true;
      try {
        // Keep a video transceiver ready so either side can enable camera later.
        if (
          !pc
            .getTransceivers()
            .some(
              (item) =>
                item.receiver.track.kind === "video" ||
                item.sender.track?.kind === "video",
            )
        ) {
          pc.addTransceiver("video", { direction: "recvonly" });
        }
        acceptReadyRef.current = true;
        optimizePeerConnection(pc);
        // Explicit transceivers already cover audio+video m-lines;
        // offerToReceive* flags would add duplicate m-lines.
        const offer = await pc.createOffer({
          iceRestart: iceRestartsRef.current > 0,
        });
        if (callIdRef.current !== activeCallId) return;
        await setLocalDescriptionTuned(pc, offer);
        void applyAudioSenders([pc]);
        emitSignal(peerId, "offer", {
          type: offer.type,
          sdp: offer.sdp,
        });
        if (cameraWasOffRef.current || !cameraTrackRef.current?.enabled) {
          emitSignal(peerId, "camera-off");
        }
      } finally {
        makingOfferRef.current = false;
      }

      if (
        callIdRef.current === activeCallId &&
        pendingOfferRef.current &&
        acceptReadyRef.current
      ) {
        const queued = pendingOfferRef.current;
        pendingOfferRef.current = null;
        try {
          await answerRemoteOffer(peerId, queued);
        } catch {
          /* ignore glare recovery failure */
        }
      }
    },
    [getMedia, ensurePc, emitSignal, answerRemoteOffer],
  );

  const restartWithRelay = useCallback(
    async (peerId: string) => {
      const peer = peerRef.current;
      const callId = callIdRef.current;
      if (!socket || !peer || !callId || peerLeftRef.current) return;
      if (relayTriedRef.current) {
        setStatus("Связь потеряна");
        return;
      }
      relayTriedRef.current = true;
      relayOnlyRef.current = true;
      iceRestartsRef.current = 0;
      restartStreakRef.current = { count: 0, since: 0 };
      stallTicksRef.current = 0;
      stallRecoveryRef.current = true;
      setStatus("Переподключение через TURN…");
      try {
        await createOffer(peerId, peer.mode, { resetPc: true });
      } catch {
        setStatus("Связь потеряна");
      }
    },
    [socket, createOffer],
  );

  const restartIce = useCallback(
    async (peerId: string) => {
      const pc = pcRef.current;
      const callId = callIdRef.current;
      if (!socket || !pc || !callId || peerLeftRef.current) return;
      const now = Date.now();
      const streak = restartStreakRef.current;
      if (now - streak.since > RESTART_STREAK_WINDOW_MS) {
        streak.count = 0;
        streak.since = now;
      }
      streak.count += 1;
      if (streak.count > MAX_ICE_RESTARTS) {
        // Direct candidates keep failing — fall back to TURN relay once.
        // The streak survives markConnected resets of iceRestartsRef,
        // so a flapping connection still reaches the relay fallback.
        void restartWithRelay(peerId);
        return;
      }

      iceRestartsRef.current += 1;
      stallTicksRef.current = 0;
      stallRecoveryRef.current = true;
      setStatus("Переподключение…");
      try {
        makingOfferRef.current = true;
        optimizePeerConnection(pc);
        const offer = await pc.createOffer({ iceRestart: true });
        if (callIdRef.current !== callId) return;
        await setLocalDescriptionTuned(pc, offer);
        emitSignal(peerId, "offer", {
          type: offer.type,
          sdp: offer.sdp,
        });
      } catch {
        setStatus("Связь потеряна");
      } finally {
        makingOfferRef.current = false;
      }

      if (
        callIdRef.current === callId &&
        pendingOfferRef.current &&
        acceptReadyRef.current
      ) {
        const queued = pendingOfferRef.current;
        pendingOfferRef.current = null;
        try {
          await answerRemoteOffer(peerId, queued);
        } catch {
          /* ignore */
        }
      }
    },
    [socket, emitSignal, answerRemoteOffer, restartWithRelay],
  );
  useEffect(() => {
    restartIceRef.current = restartIce;
  }, [restartIce]);

  const startRingTimer = useCallback((onTimeout: () => void) => {
    if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
    ringTimerRef.current = setTimeout(onTimeout, RING_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    busyRef.current = Boolean(active || incoming);
    setLiveMediaSession("call", Boolean(active || incoming),
      Boolean(active && connectedAtRef.current && localStream && !mediaBusy && !sharingScreen));
    return () => setLiveMediaSession("call", false);
  }, [active, incoming, localStream, status, mediaBusy, sharingScreen]);

  useEffect(() => {
    if (!active || !active.callId || resumeControlsRef.current) return;
    const persist = () =>
      saveMediaResume({
        kind: "call",
        peerId: active.peerId,
        peerName: active.peerName,
        chatId: active.chatId,
        mode: active.mode,
        muted,
        deafened,
        cameraOff,
        callId: active.callId,
        connectedAt: connectedAtRef.current || resumedConnectedAtRef.current || undefined,
        sharingScreen,
      });
    persist();
    const unbind = registerMediaResumePersist(persist);
    const timer = window.setInterval(persist, 15_000);
    return () => {
      unbind();
      window.clearInterval(timer);
    };
  }, [active, muted, deafened, cameraOff, sharingScreen, localStream]);

  const startCall = useCallback(
    async (
      peerId: string,
      peerName: string,
      mode: CallMode,
      chatId: string,
      opts?: { reconnect?: boolean },
    ) => {
      if (!socket || !selfId) return;
      if (busyRef.current) {
        if (!opts?.reconnect) setStatus("Уже есть активный звонок");
        return;
      }

      busyRef.current = true;
      const saved = opts?.reconnect ? peekMediaResume() : null;
      if (opts?.reconnect) prepareResumeControls(peerId, chatId);
      outboundRef.current = true;
      peerLeftRef.current = false;
      setMinimized(false);
      setActive({
        peerId,
        peerName,
        mode,
        chatId,
        outbound: true,
        callId: "",
      });
      if (!opts?.reconnect) setStatus("Звоним…");

      try {
        await ensureIceServers();
        await getMedia(mode);
      } catch (error) {
        const message =
          error instanceof Error && /микрофон|microphone|NotAllowed|Permission/i.test(error.message)
            ? "Нет доступа к микрофону"
            : "Не удалось начать звонок";
        setStatus(message);
        scheduleCleanup(1400);
        return;
      }

      if (!opts?.reconnect) {
        startRingTimer(() => {
          setStatus("Нет ответа");
          clearMediaResume();
          if (peerRef.current) {
            emitSignal(peerId, "end");
            onLog?.(chatId, "Звонок без ответа");
          }
          scheduleCleanup(1400);
        });
      }

      const inviteOnce = () =>
        new Promise<{
          ok: boolean;
          callId?: string;
          resume?: boolean;
          role?: "caller" | "callee";
          peerPresent?: boolean;
          error?: string;
        }>((resolve) => {
          socket.emit(
            "call:invite",
            { toUserId: peerId, mode, chatId, reconnect: Boolean(opts?.reconnect),
              callId: saved?.kind === "call" ? saved.callId : undefined },
            (result: {
              ok: boolean;
              callId?: string;
              resume?: boolean;
              role?: "caller" | "callee";
              peerPresent?: boolean;
              error?: string;
            }) => resolve(result || { ok: false }),
          );
        });

      let result = await inviteOnce();
      if (opts?.reconnect) {
        for (let attempt = 0; attempt < 16 && !result.ok; attempt += 1) {
          if (result.error && result.error !== "Собеседник не в сети") break;
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          if (!busyRef.current) return;
          result = await inviteOnce();
        }
      }

      if (!result?.ok || !result.callId) {
        setStatus(result?.error || "Не удалось позвонить");
        if (!opts?.reconnect) clearMediaResume();
        scheduleCleanup(1400);
        return;
      }
      callIdRef.current = result.callId;
      peerRef.current = { peerId, chatId, mode, callId: result.callId };
      setActive((prev) =>
        prev ? { ...prev, callId: result.callId!, outbound: result.role !== "callee" } : prev,
      );

      if (result.resume) {
        if (ringTimerRef.current) {
          clearTimeout(ringTimerRef.current);
          ringTimerRef.current = null;
        }
        setStatus("Переподключение…");
        if (result.peerPresent === false) return;
        try {
          if (result.role === "callee") {
            acceptReadyRef.current = true;
            emitSignal(peerId, "accept");
          } else {
            await createOffer(peerId, mode, { resetPc: true });
          }
        } catch {
          setStatus("Не удалось переподключить звонок");
        }
      }
    },
    [socket, selfId, startRingTimer, onLog, scheduleCleanup, emitSignal, getMedia, ensureIceServers, createOffer, prepareResumeControls],
  );

  const acceptCall = useCallback(async (incomingOverride?: IncomingCall | any) => {
    const isEvent = incomingOverride && typeof incomingOverride === "object" && "preventDefault" in incomingOverride;
    const target = (isEvent ? undefined : incomingOverride as IncomingCall) || incoming;
    if (!socket || !target?.callId) return;
    const { fromUserId, fromName, mode, chatId, callId } = target;
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    void closeNotifyByTag(`pulse-call-${callId}`);

    const queuedOffer = pendingOfferRef.current;
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      pendingIceRef.current = [];
      remoteReadyRef.current = false;
      makingOfferRef.current = false;
    }
    pendingOfferRef.current = queuedOffer;

    busyRef.current = true;
    outboundRef.current = false;
    peerLeftRef.current = false;
    callIdRef.current = callId;
    setIncoming(null);
    setMinimized(false);
    setActive({
      peerId: fromUserId,
      peerName: fromName,
      mode,
      chatId,
      outbound: false,
      callId,
    });
    peerRef.current = { peerId: fromUserId, chatId, mode, callId };
    setStatus(target.reconnect ? "Переподключение…" : "Соединение…");

    try {
      await ensureIceServers();
      const stream = await getMedia(mode);
      if (callIdRef.current !== callId) {
        stream.getTracks().forEach((track) => track.stop());
        if (localStreamRef.current === stream) {
          localStreamRef.current = null;
          cameraTrackRef.current = null;
          setLocalStream(null);
        }
        return;
      }
      const pc = ensurePc(fromUserId);
      stream.getTracks().forEach((track) => {
        if (!pc.getSenders().some((sender) => sender.track === track)) {
          pc.addTrack(track, stream);
        }
      });
      void applyAudioSenders([pc]);
      acceptReadyRef.current = true;

      // Accept only after local media is attached — avoids answer without tracks.
      emitSignal(fromUserId, "accept");
      emitSignal(fromUserId, "camera-off");

      const offer = pendingOfferRef.current;
      if (offer) {
        pendingOfferRef.current = null;
        await answerRemoteOffer(fromUserId, offer);
      }
    } catch {
      if (!localStreamRef.current) {
        setStatus("Нет доступа к микрофону");
        emitSignal(fromUserId, "reject");
        scheduleCleanup(1400);
        return;
      }
      acceptReadyRef.current = true;
      emitSignal(fromUserId, "accept");
      setStatus("Соединение…");
    }
  }, [
    socket,
    incoming,
    getMedia,
    ensurePc,
    emitSignal,
    scheduleCleanup,
    ensureIceServers,
    answerRemoteOffer,
  ]);

  const rejectCall = useCallback(() => {
    if (!socket || !incoming) return;
    clearMediaResume();
    callIdRef.current = incoming.callId;
    void closeNotifyByTag(`pulse-call-${incoming.callId}`);
    emitSignal(incoming.fromUserId, "reject");
    setIncoming(null);
    pendingOfferRef.current = null;
    callIdRef.current = null;
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    busyRef.current = false;
  }, [socket, incoming, emitSignal]);

  const endCall = useCallback(() => {
    clearMediaResume();
    const peer = peerRef.current;
    markCallHungUp(callIdRef.current);
    if (socket && peer) {
      emitSignal(peer.peerId, "end");
      const label = "Звонок завершён";
      const withTime =
        connectedAtRef.current && duration > 0
          ? `${label} · ${formatDuration(duration)}`
          : label;
      onLog?.(peer.chatId, withTime);
    }
    cleanup();
  }, [socket, cleanup, onLog, duration, emitSignal]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMicEnabled(
      localStreamRef.current,
      !next,
      noiseFilterRef.current?.sourceTrack,
    );
    setMuted(next);
    mutedRef.current = next;
    if (!next && deafenedRef.current) {
      deafenedRef.current = false;
      setDeafened(false);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.muted = false;
        void remoteAudioRef.current.play().catch(() => undefined);
      }
      if (screenAudioElRef.current) {
        screenAudioElRef.current.muted = false;
        void screenAudioElRef.current.play().catch(() => undefined);
      }
    }
  }, [muted]);

  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = next;
      if (!next) void remoteAudioRef.current.play().catch(() => undefined);
    }
    if (screenAudioElRef.current) {
      screenAudioElRef.current.muted = next;
      if (!next) void screenAudioElRef.current.play().catch(() => undefined);
    }
    if (next) {
      if (!muted) {
        setMuted(true);
        mutedRef.current = true;
        setMicEnabled(
          localStreamRef.current,
          false,
          noiseFilterRef.current?.sourceTrack,
        );
      }
    } else if (muted) {
      setMuted(false);
      mutedRef.current = false;
      setMicEnabled(
        localStreamRef.current,
        true,
        noiseFilterRef.current?.sourceTrack,
      );
    }
  }, [muted]);

  const toggleNoiseFilter = useCallback(() => {
    setNeuralNoiseEnabled(!getNeuralNoiseEnabled());
  }, []);

  const applyVoiceSettings = useCallback(
    async (change: VoiceSettingsChange) => {
      if (change.speaker) {
        await applyAudioOutput(remoteAudioRef.current);
      }
      setNoiseFilterEnabled(getNeuralNoiseEnabled());
      if (!change.mic && !change.noise) return;
      if (!localStreamRef.current) return;
      try {
        if (!change.mic && noiseFilterRef.current) {
          const filter = noiseFilterRef.current;
          await filter.setEnabled(getNeuralNoiseEnabled());
          setNoiseFilterKind(filter.kind);
          return;
        }
        const previousStream = localStreamRef.current;
        const next = await captureFilteredMic();
        try {
          if (localStreamRef.current !== previousStream) {
            await stopNoiseFilter(next.filter);
            return;
          }
          const prev = noiseFilterRef.current;
          const stream = withReplacedAudioTrack(
            localStreamRef.current,
            next.filter.outputTrack,
          );
          if (mutedRef.current) {
            setMicEnabled(stream, false, next.filter.sourceTrack);
          }
          await replaceAudioSenders(
            [pcRef.current],
            stream,
            next.filter.outputTrack,
          );
          noiseFilterRef.current = next.filter;
          localStreamRef.current = stream;
          setLocalStream(stream);
          setNoiseFilterKind(next.filter.kind);
          await stopNoiseFilter(prev);
        } catch (err) {
          await stopNoiseFilter(next.filter);
          throw err;
        }
      } catch {
        /* keep previous capture if the new device fails */
      }
    },
    [],
  );

  useEffect(() => subscribeVoiceSettings((change) => {
    voiceSettingsUpdateRef.current = voiceSettingsUpdateRef.current
      .catch(() => undefined).then(() => applyVoiceSettings(change));
  }), [applyVoiceSettings]);

  const performToggleCamera = useCallback(async () => {
    const turningOn = cameraOff;
    const pc = pcRef.current;
    const peer = peerRef.current;

    if (turningOn) {
      let track = cameraTrackRef.current;
      if (!track || track.readyState === "ended") {
        try {
          const cam = await openCameraStream(cameraFacingRef.current);
          track = cam.getVideoTracks()[0];
          if (!track) throw new Error("no-video");
          setCanFlipCamera(await phoneCanFlipCamera());
          prepareCameraTrack(track);
          track.onended = () => {
            if (cameraTrackRef.current !== track) return;
            cameraTrackRef.current = null;
            cameraWasOffRef.current = true;
            setCameraOff(true);
            localCameraOffRef.current = true;
            setStatus("Камера отключена");
            publishLocalVideos();
            const endedPc = pcRef.current;
            if (endedPc) void detachLocalVideoTrackByHint(endedPc, "motion");
            if (peerRef.current && socket) {
              emitSignal(peerRef.current.peerId, "camera-off");
              emitCurrentMediaState(true, localSharingScreenRef.current);
            }
          };
          cameraTrackRef.current = track;
        } catch {
          setCameraOff(true);
          setStatus("Нет доступа к камере");
          return;
        }
      } else {
        prepareCameraTrack(track);
      }

      track.enabled = true;
      cameraWasOffRef.current = false;
      setCameraOff(false);
      localCameraOffRef.current = false;
      setStatus("На линии");

      const media = publishLocalVideos();
      try {
        if (pc) {
          const sender = await attachLocalVideoTrackByHint(
            pc,
            track,
            media,
            "motion",
          );
          await applyVideoSenderParams(sender, {
            maxBitrate: CAMERA_SEND_PARAMS.maxBitrate,
            maxFramerate: CAMERA_SEND_PARAMS.maxFramerate,
          });
          videoQualityKeyRef.current = {};
        }
      } catch {
        /* keep local preview even if renegotiation lags */
      }

      if (peer && socket) {
        emitSignal(peer.peerId, "camera-on");
        emitCurrentMediaState(false, localSharingScreenRef.current);
      }
      return;
    }

    if (cameraTrackRef.current) {
      cameraTrackRef.current.stop();
      cameraTrackRef.current = null;
    }
    cameraWasOffRef.current = true;
    setCameraOff(true);
    localCameraOffRef.current = true;
    if (pc) await detachLocalVideoTrackByHint(pc, "motion");
    publishLocalVideos();

    if (peer && socket) {
      emitSignal(peer.peerId, "camera-off");
      emitCurrentMediaState(true, localSharingScreenRef.current);
    }
  }, [
    cameraOff,
    applyVideoSenderParams,
    socket,
    emitSignal,
    emitCurrentMediaState,
    publishLocalVideos,
  ]);

  const toggleCamera = useCallback(async () => {
    if (mediaBusyRef.current) return;
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      await performToggleCamera();
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  }, [performToggleCamera]);

  const flipCamera = useCallback(async () => {
    if (mediaBusyRef.current || cameraWasOffRef.current) return;
    const pc = pcRef.current;
    const previous = cameraTrackRef.current;
    const nextFacing: CameraFacing =
      cameraFacingRef.current === "user" ? "environment" : "user";
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      const cam = await openCameraStream(nextFacing);
      const track = cam.getVideoTracks()[0];
      if (!track) throw new Error("no-video");
      prepareCameraTrack(track);
      track.onended = () => {
        if (cameraTrackRef.current !== track) return;
        cameraTrackRef.current = null;
        cameraWasOffRef.current = true;
        setCameraOff(true);
        localCameraOffRef.current = true;
        setStatus("Камера отключена");
        publishLocalVideos();
        const endedPc = pcRef.current;
        if (endedPc) void detachLocalVideoTrackByHint(endedPc, "motion");
      };
      cameraFacingRef.current = nextFacing;
      cameraTrackRef.current = track;
      previous?.stop();
      const media = publishLocalVideos();
      if (pc) {
        const sender = await attachLocalVideoTrackByHint(
          pc,
          track,
          media,
          "motion",
        );
        await applyVideoSenderParams(sender, {
          maxBitrate: CAMERA_SEND_PARAMS.maxBitrate,
          maxFramerate: CAMERA_SEND_PARAMS.maxFramerate,
        });
        videoQualityKeyRef.current = {};
      }
      setCanFlipCamera(true);
    } catch {
      setStatus("Не удалось переключить камеру");
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  }, [applyVideoSenderParams, publishLocalVideos]);

  const performToggleScreenShare = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer) {
      setStatus("Демонстрация экрана недоступна");
      return;
    }
    if (sharingScreen) {
      stopScreenShare();
      return;
    }

    let pc = pcRef.current;
    if (!pc || pc.connectionState === "closed") {
      pcRef.current = null;
      pc = ensurePc(peer.peerId);
    }

    let display: MediaStream | null = null;
    let screenAudioWarning: string | undefined;
    try {
      display = await captureScreenShare({
        onAudioUnavailable: (message) => {
          screenAudioWarning = message;
          setStatus(message);
        },
      });
      const track = display.getVideoTracks()[0];
      if (!track) {
        display.getTracks().forEach((item) => item.stop());
        setStatus("Демонстрация экрана недоступна");
        return;
      }
      const extraAudio = display.getAudioTracks().slice(1);
      for (const audio of extraAudio) {
        audio.stop();
        display.removeTrack(audio);
      }
      const screenAudio = display.getAudioTracks()[0] || null;

      prepareScreenTrack(track);
      screenTrackRef.current = track;
      screenAudioTrackRef.current = screenAudio;
      const media = publishLocalVideos();
      makingOfferRef.current = true;
      try {
        const sender = await attachLocalVideoTrackByHint(
          pc,
          track,
          media,
          "detail",
        );
        await applyVideoSenderParams(sender, {
          maxBitrate: SCREEN_SEND_PARAMS.maxBitrate,
          maxFramerate: SCREEN_SEND_PARAMS.maxFramerate,
          maintainResolution: true,
        });
        videoQualityKeyRef.current = {};
        if (screenAudio) {
          await attachLocalScreenAudioTrack(pc, screenAudio, media);
        }
        if (pc.signalingState === "stable") {
          optimizePeerConnection(pc);
          const offer = await pc.createOffer();
          if (pcRef.current === pc && callIdRef.current && pc.signalingState === "stable") {
            await setLocalDescriptionTuned(pc, offer);
            emitSignal(peer.peerId, "offer", {
              type: offer.type,
              sdp: offer.sdp,
            });
          }
        }
      } finally {
        makingOfferRef.current = false;
      }

      setSharingScreen(true);
      localSharingScreenRef.current = true;
      setStatus(screenAudioWarning || "Демонстрация экрана");
      emitSignal(peer.peerId, "screen-on");
      emitCurrentMediaState(cameraWasOffRef.current, true);
      track.onended = () => {
        stopScreenShare();
      };
    } catch (error) {
      screenTrackRef.current?.stop();
      screenTrackRef.current = null;
      display?.getTracks().forEach((item) => item.stop());
      publishLocalVideos();
      const name =
        error && typeof error === "object" && "name" in error
          ? String((error as { name?: string }).name)
          : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setStatus("Демонстрация экрана отклонена");
      } else {
        setStatus("Демонстрация экрана недоступна");
      }
    }
  }, [
    sharingScreen,
    stopScreenShare,
    emitSignal,
    emitCurrentMediaState,
    applyVideoSenderParams,
    publishLocalVideos,
    ensurePc,
  ]);

  const toggleScreenShare = useCallback(async () => {
    if (mediaBusyRef.current) return;
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      await performToggleScreenShare();
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  }, [performToggleScreenShare]);

  const refreshLocalVideoForPeer = useCallback(
    async (peerId: string) => {
      const pc = pcRef.current;
      if (!pc) return;
      const screen =
        screenTrackRef.current?.readyState === "live"
          ? screenTrackRef.current
          : null;
      const camera =
        !cameraWasOffRef.current &&
        cameraTrackRef.current?.readyState === "live"
          ? cameraTrackRef.current
          : null;
      if (!screen && !camera) {
        emitCurrentMediaState(true, false);
        return;
      }

      const media = publishLocalVideos();
      try {
        if (camera) {
          const sender = await attachLocalVideoTrackByHint(
            pc,
            camera,
            media,
            "motion",
          );
          await applyVideoSenderParams(sender, {
            maxBitrate: CAMERA_SEND_PARAMS.maxBitrate,
            maxFramerate: CAMERA_SEND_PARAMS.maxFramerate,
          });
          videoQualityKeyRef.current = {};
        }
        if (screen) {
          const sender = await attachLocalVideoTrackByHint(
            pc,
            screen,
            media,
            "detail",
          );
          await applyVideoSenderParams(sender, {
            maxBitrate: SCREEN_SEND_PARAMS.maxBitrate,
            maxFramerate: SCREEN_SEND_PARAMS.maxFramerate,
            maintainResolution: true,
          });
          videoQualityKeyRef.current = {};
        }
        emitCurrentMediaState(!camera, Boolean(screen));

        if (!makingOfferRef.current && pc.signalingState === "stable") {
          makingOfferRef.current = true;
          try {
            optimizePeerConnection(pc);
            const offer = await pc.createOffer();
            if (pcRef.current !== pc || pc.signalingState !== "stable") return;
            await setLocalDescriptionTuned(pc, offer);
            emitSignal(peerId, "offer", {
              type: offer.type,
              sdp: offer.sdp,
            });
          } finally {
            makingOfferRef.current = false;
          }
        }
      } catch {
        /* the regular ICE recovery loop will retry the connection */
      }
    },
    [applyVideoSenderParams, emitCurrentMediaState, emitSignal, publishLocalVideos],
  );

  useEffect(() => {
    if (!socket) return;

    const onIncoming = (payload: IncomingCall) => {
      if (!payload?.callId) return;
      const live = callPcAlive(pcRef.current);
      const autoReconnect = Boolean(payload.reconnect) && live;
      if ((busyRef.current || peerRef.current) && live && !autoReconnect) {
        callIdRef.current = payload.callId;
        emitSignal(payload.fromUserId, "reject");
        callIdRef.current = peerRef.current?.callId || null;
        return;
      }
      if (!live) {
        try {
          pcRef.current?.close();
        } catch {
          /* ignore */
        }
        pcRef.current = null;
        peerRef.current = null;
        busyRef.current = false;
        setActive(null);
      }
      if (autoReconnect) {
        void acceptCall(payload);
        return;
      }
      setIncoming(payload);
      setMinimized(false);
      callIdRef.current = payload.callId;
      // OS banner when permission already granted (request only from Profile UI).
      if (getNotifyPermission() === "granted") {
        showIncomingCallNotify(
          payload.fromName || "Майко",
          payload.chatId,
          payload.callId,
        );
      }
      startRingTimer(() => {
        void closeNotifyByTag(`pulse-call-${payload.callId}`);
        setIncoming(null);
        pendingOfferRef.current = null;
        emitSignal(payload.fromUserId, "reject");
        callIdRef.current = null;
        busyRef.current = false;
      });
    };

    const onSignal = async (payload: {
      callId?: string;
      fromUserId: string;
      fromName: string;
      type:
        | "offer"
        | "answer"
        | "ice"
        | "accept"
        | "reject"
        | "end"
        | "peer-left"
        | "screen-on"
        | "screen-off"
        | "camera-on"
        | "camera-off"
        | "media-request"
        | "media-state";
      data?:
        | RTCSessionDescriptionInit
        | RTCIceCandidateInit
        | CallMediaState
        | { reason?: string }
        | null;
    }) => {
      if (!payload.callId) return;

      if (
        callIdRef.current &&
        payload.callId !== callIdRef.current &&
        payload.type !== "end" &&
        payload.type !== "reject" &&
        payload.type !== "peer-left"
      ) {
        return;
      }

      if (
        !callIdRef.current &&
        (payload.type === "end" ||
          payload.type === "reject" ||
          payload.type === "peer-left")
      ) {
        if (incoming && incoming.callId === payload.callId) {
          setIncoming(null);
        }
        return;
      }

      if (payload.type === "media-state") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        const state = payload.data as CallMediaState | null;
        if (
          !state ||
          typeof state.revision !== "number" ||
          state.revision < remoteMediaRevisionRef.current
        ) {
          return;
        }
        remoteMediaRevisionRef.current = state.revision;
        setRemoteCameraOff(Boolean(state.cameraOff));
        setRemoteSharingScreen(Boolean(state.sharingScreen));
        if (!state.cameraOff || state.sharingScreen) {
          scheduleRemoteMediaRecovery(payload.fromUserId, state.revision);
        } else if (mediaRecoveryTimerRef.current) {
          clearTimeout(mediaRecoveryTimerRef.current);
          mediaRecoveryTimerRef.current = null;
        }
        return;
      }

      if (payload.type === "media-request") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        void refreshLocalVideoForPeer(payload.fromUserId);
        return;
      }

      if (payload.type === "screen-on") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        if (remoteMediaRevisionRef.current >= 0) return;
        setRemoteSharingScreen(true);
        return;
      }

      if (payload.type === "screen-off") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        if (remoteMediaRevisionRef.current >= 0) return;
        setRemoteSharingScreen(false);
        return;
      }

      if (payload.type === "camera-on") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        if (remoteMediaRevisionRef.current >= 0) return;
        setRemoteCameraOff(false);
        return;
      }

      if (payload.type === "camera-off") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        if (remoteMediaRevisionRef.current >= 0) return;
        setRemoteCameraOff(true);
        return;
      }

      if (payload.type === "reject") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        clearMediaResume();
        if (ringTimerRef.current) {
          clearTimeout(ringTimerRef.current);
          ringTimerRef.current = null;
        }
        setStatus("Звонок отклонён");
        scheduleCleanup(1400);
        return;
      }

      if (payload.type === "peer-left") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        const reason =
          payload.data &&
          typeof payload.data === "object" &&
          "reason" in payload.data
            ? String((payload.data as { reason?: string }).reason || "")
            : "";
        if (reason === "disconnect" && callPcAlive(pcRef.current)) {
          setStatus("Собеседник переподключается…");
          if (peerReturnTimerRef.current) {
            clearTimeout(peerReturnTimerRef.current);
          }
          peerReturnTimerRef.current = setTimeout(() => {
            peerReturnTimerRef.current = null;
            if (!callIdRef.current || peerLeftRef.current) return;
            if (callPcAlive(pcRef.current)) return;
            // Peer never came back — exit cleanly instead of hanging.
            setStatus("Собеседник недоступен");
            endAndCleanup(900);
          }, 30_000);
          return;
        }
        if (ringTimerRef.current) {
          clearTimeout(ringTimerRef.current);
          ringTimerRef.current = null;
        }
        dropRemotePeer();
        return;
      }

      if (payload.type === "end") {
        if (callIdRef.current && payload.callId !== callIdRef.current) return;
        if (connectedAtRef.current) {
          dropRemotePeer();
          return;
        }
        clearMediaResume();
        if (ringTimerRef.current) {
          clearTimeout(ringTimerRef.current);
          ringTimerRef.current = null;
        }
        setStatus("Звонок завершён");
        scheduleCleanup(900);
        return;
      }

      if (payload.type === "accept") {
        if (ringTimerRef.current) {
          clearTimeout(ringTimerRef.current);
          ringTimerRef.current = null;
        }
        setStatus("Соединение…");
        const peer = peerRef.current;
        if (peer && peer.callId === payload.callId) {
          try {
            await createOffer(peer.peerId, peer.mode, {
              resetPc: Boolean(connectedAtRef.current),
            });
          } catch {
            setStatus("Нет доступа к микрофону/камере");
            endAndCleanup(1400);
          }
        }
        return;
      }

      if (payload.type === "offer" && payload.data) {
        callIdRef.current = payload.callId;
        if (!peerRef.current || !acceptReadyRef.current || makingOfferRef.current) {
          pendingOfferRef.current = payload.data as RTCSessionDescriptionInit;
          return;
        }
        try {
          await answerRemoteOffer(
            payload.fromUserId,
            payload.data as RTCSessionDescriptionInit,
          );
        } catch {
          pendingOfferRef.current = payload.data as RTCSessionDescriptionInit;
        }
        return;
      }

      if (payload.type === "answer" && payload.data) {
        const pc = ensurePc(payload.fromUserId);
        if (pc.signalingState === "stable") return;
        await setRemoteDescriptionWithAudioRouting(pc, payload.data as RTCSessionDescriptionInit);
        publishRemoteStream();
        remoteReadyRef.current = true;
        await flushIce(pc);
        return;
      }

      if (payload.type === "ice" && payload.data) {
        const candidate = payload.data as RTCIceCandidateInit;
        const pc = pcRef.current || ensurePc(payload.fromUserId);
        if (!remoteReadyRef.current) {
          pendingIceRef.current.push(candidate);
          return;
        }
        try {
          await pc.addIceCandidate(candidate);
        } catch {
          /* ignore */
        }
      }
    };

    const onDismiss = (payload: { callId?: string }) => {
      if (!payload?.callId) return;
      setIncoming((current) =>
        current?.callId === payload.callId ? null : current,
      );
      if (
        !peerRef.current &&
        callIdRef.current === payload.callId
      ) {
        callIdRef.current = null;
        pendingOfferRef.current = null;
        busyRef.current = false;
        if (ringTimerRef.current) {
          clearTimeout(ringTimerRef.current);
          ringTimerRef.current = null;
        }
      }
    };

    const onResume = async (payload: {
      callId?: string;
      peerId?: string;
      peerName?: string;
      mode?: CallMode;
      chatId?: string;
      role?: "caller" | "callee";
      peerPresent?: boolean;
    }) => {
      const callId = String(payload?.callId || "");
      const peerId = String(payload?.peerId || "");
      const mode = payload?.mode === "video" ? "video" : "audio";
      const chatId = String(payload?.chatId || "");
      if (!callId || !peerId || !chatId) return;
      if (consumeCallHungUp(callId)) {
        socket.emit("call:signal", {
          callId,
          toUserId: peerId,
          type: "end",
        });
        return;
      }
      if (callIdRef.current === callId && callPcAlive(pcRef.current)) {
        peerLeftRef.current = false;
        return;
      }
      prepareResumeControls(peerId, chatId, callId);
      if (payload.peerPresent === false && !callPcAlive(pcRef.current)) {
        busyRef.current = true;
        peerLeftRef.current = false;
        outboundRef.current = payload?.role !== "callee";
        callIdRef.current = callId;
        peerRef.current = { peerId, chatId, mode, callId };
        setIncoming(null);
        setMinimized(false);
        setActive({
          peerId,
          peerName: payload.peerName || "Майко",
          mode,
          chatId,
          outbound: payload?.role !== "callee",
          callId,
        });
        setStatus("Переподключение…");
        return;
      }
      if (!callPcAlive(pcRef.current) && busyRef.current && !peerRef.current) {
        return;
      }
      if (busyRef.current && peerRef.current && peerRef.current.peerId !== peerId) {
        return;
      }
      busyRef.current = true;
      peerLeftRef.current = false;
      outboundRef.current = payload?.role !== "callee";
      callIdRef.current = callId;
      peerRef.current = { peerId, chatId, mode, callId };
      setIncoming(null);
      setMinimized(false);
      setActive({
        peerId,
        peerName: payload.peerName || "Майко",
        mode,
        chatId,
        outbound: payload?.role !== "callee",
        callId,
      });
      if (callPcAlive(pcRef.current)) {
        setStatus("На линии");
        return;
      }
      setStatus("Переподключение…");
      try {
        await ensureIceServers();
        if (!localStreamRef.current) await getMedia(mode);
        if (callIdRef.current !== callId) return;
        if (payload?.role === "callee") {
          acceptReadyRef.current = true;
          emitSignal(peerId, "accept");
        } else {
          await createOffer(peerId, mode, { resetPc: true });
        }
      } catch {
        setStatus("Не удалось переподключить звонок");
      }
    };

    const onRenegotiate = async (payload: {
      callId?: string;
      fromUserId?: string;
      mode?: CallMode;
      chatId?: string;
    }) => {
      const callId = String(payload?.callId || "");
      const peer = peerRef.current;
      if (!callId || !peer || peer.callId !== callId) return;
      peerLeftRef.current = false;
      if (callPcAlive(pcRef.current)) {
        setStatus("На линии");
        return;
      }
      setStatus("Переподключение…");
      try {
        await ensureIceServers();
        if (!localStreamRef.current) await getMedia(peer.mode);
        if (callIdRef.current !== callId) return;
        if (outboundRef.current) {
          await createOffer(peer.peerId, peer.mode, { resetPc: true });
          return;
        }
        if (pcRef.current) {
          try {
            pcRef.current.close();
          } catch {
            /* ignore */
          }
          pcRef.current = null;
        }
        pendingOfferRef.current = null;
        pendingIceRef.current = [];
        remoteReadyRef.current = false;
        makingOfferRef.current = false;
        const stream = localStreamRef.current;
        const pc = ensurePc(peer.peerId);
        stream?.getTracks().forEach((track) => {
          if (!pc.getSenders().some((sender) => sender.track === track)) {
            pc.addTrack(track, stream);
          }
        });
        void applyAudioSenders([pc]);
        acceptReadyRef.current = true;
      } catch {
        /* keep the overlay; ICE recovery may still help */
      }
    };

    socket.on("call:incoming", onIncoming);
    socket.on("call:signal", onSignal);
    socket.on("call:dismiss", onDismiss);
    socket.on("call:resume", onResume);
    socket.on("call:renegotiate", onRenegotiate);
    const onPeerReload = (payload: { callId?: string }) => {
      if (payload.callId === callIdRef.current) setStatus("Собеседник обновляет приложение…");
    };
    socket.on("call:reloading", onPeerReload);
    const onSocketDown = () => {
      // Deploy/network blip — media stays up, signaling recovers via resume.
      if (callIdRef.current) setStatus("Переподключение к серверу…");
    };
    socket.on("disconnect", onSocketDown);
    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:signal", onSignal);
      socket.off("call:dismiss", onDismiss);
      socket.off("call:resume", onResume);
      socket.off("call:renegotiate", onRenegotiate);
      socket.off("call:reloading", onPeerReload);
      socket.off("disconnect", onSocketDown);
    };
  }, [
    socket,
    ensurePc,
    createOffer,
    flushIce,
    scheduleCleanup,
    endAndCleanup,
    dropRemotePeer,
    startRingTimer,
    emitSignal,
    answerRemoteOffer,
    publishRemoteStream,
    refreshLocalVideoForPeer,
    scheduleRemoteMediaRecovery,
    incoming,
    acceptCall,
    getMedia,
    ensureIceServers,
    prepareResumeControls,
  ]);

  useEffect(() => {
    if (!active) return;
    emitCurrentMediaState();
    const timer = window.setInterval(() => {
      emitCurrentMediaState();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, emitCurrentMediaState]);

  useEffect(() => {
    if (!token) return;
    void getClientIceServers(token).then((servers) => {
      if (servers.length) iceServersRef.current = servers;
    });
  }, [token]);

  useEffect(() => {
    if (!active) return;
    const resumeRemoteMedia = () => {
      if (document.visibilityState === "hidden") return;
      publishRemoteStream();
      void remoteAudioRef.current?.play().catch(() => undefined);
      void screenAudioElRef.current?.play().catch(() => undefined);
    };
    const onVisibility = () => {
      videoQualityKeyRef.current = {};
      void adaptVideoQuality(lastNetworkRef.current?.level || "good");
      resumeRemoteMedia();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", resumeRemoteMedia);
    window.addEventListener("pointerdown", resumeRemoteMedia, {
      capture: true,
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", resumeRemoteMedia);
      window.removeEventListener("pointerdown", resumeRemoteMedia, {
        capture: true,
      });
    };
  }, [active, adaptVideoQuality, publishRemoteStream]);

  useEffect(() => {
    const previousToken = sessionTokenRef.current;
    sessionTokenRef.current = token;
    if (previousToken && previousToken !== token) cleanup();
  }, [cleanup, token]);

  useEffect(
    () => () => {
      if (isPageUnloading()) return;
      cleanupRef.current();
    },
    [],
  );

  return {
    incoming,
    active,
    localStream,
    remoteStream,
    muted,
    deafened,
    cameraOff,
    sharingScreen,
    mediaBusy,
    remoteSharingScreen,
    remoteCameraOff,
    minimized,
    status,
    duration,
    durationLabel: formatDuration(duration),
    networkQuality,
    localSpeaking,
    remoteSpeaking,
    remoteAudioRef,
    noiseFilterEnabled,
    noiseFilterKind,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleDeafen,
    toggleNoiseFilter,
    toggleCamera,
    flipCamera,
    canFlipCamera,
    toggleScreenShare,
    setMinimized,
  };
}
