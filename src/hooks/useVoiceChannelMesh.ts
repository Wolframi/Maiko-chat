"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { VoiceChannelUser } from "@/lib/types";
import { getClientIceServers } from "@/lib/iceServers";
import {
  configureSpeakingAnalyser,
  createSpeakingSamples,
  pickSpeakingTrack,
  speakingLevelFromAnalyser,
  SPEAKING_HOLD_MS,
  SPEAKING_THRESHOLD,
  startSpeakingTicker,
} from "@/lib/speakingMeter";
import {
  attachLocalScreenAudioTrack,
  attachLocalVideoTrackByHint,
  applyVideoSenderParams,
  CAMERA_SEND_PARAMS,
  CAMERA_VIDEO_CONSTRAINTS,
  captureScreenShare,
  detachLocalScreenAudioTrack,
  detachLocalVideoTrackByHint,
  optimizePeerConnection,
  prepareCameraTrack,
  prepareScreenTrack,
  replaceAudioSenders,
  SCREEN_SEND_PARAMS,
  withReplacedAudioTrack,
} from "@/lib/webrtcMedia";
import {
  captureFilteredMic,
  getKrispEnabled,
  getNoiseFilterPref,
  setKrispEnabled,
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

type UseVoiceChannelOptions = {
  socket: Socket | null;
  selfId?: string;
  selfName?: string;
  token?: string | null;
  /** True when a 1:1 call is active — block joining voice. */
  callBusy?: boolean;
  /** Presence (voice:join/leave) owned by hybrid coordinator. */
  managedPresence?: boolean;
};

type ActiveVoice = {
  channelId: string;
  groupId: string;
  title: string;
};

const MEDIA_SYNC_DELAYS_MS = [0, 250, 800, 1600] as const;
const ICE_RESTART_DELAY_MS = 2500;
const MAX_ICE_RESTARTS = 3;

export function useVoiceChannelMesh({
  socket,
  selfId,
  selfName,
  token = null,
  callBusy = false,
  managedPresence = false,
}: UseVoiceChannelOptions) {
  const [active, setActive] = useState<ActiveVoice | null>(null);
  const [peers, setPeers] = useState<VoiceChannelUser[]>([]);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, MediaStream>
  >({});
  const [cameraOff, setCameraOff] = useState(true);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [peerMediaHints, setPeerMediaHints] = useState<
    Record<
      string,
      {
        cameraOff?: boolean;
        sharingScreen?: boolean;
        mediaRevision?: number;
      }
    >
  >({});

  const localStreamRef = useRef<MediaStream | null>(null);
  const pcsRef = useRef(new Map<string, RTCPeerConnection>());
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const tokenRef = useRef(token);
  const remoteAudioRef = useRef(new Map<string, HTMLAudioElement>());
  const remoteStreamsRef = useRef(new Map<string, MediaStream>());
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const signalQueueRef = useRef(new Map<string, Promise<void>>());
  const makingOfferRef = useRef(new Set<string>());
  const negotiationTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const negotiationPendingRef = useRef(new Set<string>());
  const iceRestartPeersRef = useRef(new Set<string>());
  const iceRestartTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const iceRestartAttemptsRef = useRef(new Map<string, number>());
  const remoteSyncTimersRef = useRef(
    new Map<string, Set<ReturnType<typeof setTimeout>>>(),
  );
  const mediaRecoveryTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const lastMediaRequestRef = useRef(
    new Map<string, { revision: number; at: number }>(),
  );
  const lastRemoteStreamsSignatureRef = useRef("");
  const channelIdRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const speakingRef = useRef(false);
  const speakHoldUntilRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const localSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const localAnalyserTrackIdRef = useRef<string | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraWasOffRef = useRef(true);
  const mediaBusyRef = useRef(false);
  const noiseFilterRef = useRef<NoiseFilterSession | null>(null);
  const [selfSpeaking, setSelfSpeaking] = useState(false);
  const [noiseFilterEnabled, setNoiseFilterEnabled] = useState(
    getNoiseFilterPref,
  );
  const [noiseFilterKind, setNoiseFilterKind] =
    useState<NoiseFilterKind>("browser");

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const publishRemoteStreams = useCallback(() => {
    const next: Record<string, MediaStream> = {};
    const signatures: string[] = [];
    for (const [peerId, stream] of remoteStreamsRef.current.entries()) {
      const tracks = stream
        .getTracks()
        .filter((track) => track.readyState === "live");
      if (!tracks.length) continue;
      next[peerId] = new MediaStream(tracks);
      signatures.push(
        `${peerId}:${tracks
          .map(
            (track) =>
              `${track.kind}:${track.id}:${track.readyState}:${track.enabled ? 1 : 0}:${track.muted ? 1 : 0}`,
          )
          .sort()
          .join(",")}`,
      );
    }
    const signature = signatures.sort().join("|");
    if (signature === lastRemoteStreamsSignatureRef.current) return;
    lastRemoteStreamsSignatureRef.current = signature;
    setRemoteStreams(next);
  }, []);

  const ensureRemoteAudio = useCallback((peerId: string) => {
    let audio = remoteAudioRef.current.get(peerId);
    if (audio) return audio;
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.hidden = true;
    audio.dataset.voicePeer = peerId;
    document.body.appendChild(audio);
    remoteAudioRef.current.set(peerId, audio);
    void applyAudioOutput(audio);
    return audio;
  }, []);

  const syncRemoteStream = useCallback(
    (peerId: string, eventTrack?: MediaStreamTrack) => {
      const pc = pcsRef.current.get(peerId);
      const receiverTracks = (pc?.getReceivers() || [])
        .map((receiver) => receiver.track)
        .filter((track) => track.readyState === "live");
      if (
        eventTrack?.readyState === "live" &&
        !receiverTracks.some((track) => track.id === eventTrack.id)
      ) {
        receiverTracks.push(eventTrack);
      }
      const audioTracks = receiverTracks.filter(
        (track) => track.kind === "audio",
      );
      const videoTracks = receiverTracks.filter(
        (track) => track.kind === "video",
      );
      const eventVideo =
        eventTrack?.kind === "video" ? eventTrack : undefined;
      // Rollback/glare can leave an inactive receiver before the actual
      // mobile video receiver. A video element renders only its first video
      // track, so publish exactly the receiver that is carrying frames.
      const videoTrack =
        videoTracks.find((track) => !track.muted) ||
        eventVideo ||
        videoTracks[videoTracks.length - 1];
      const tracks = [...audioTracks, videoTrack].filter(
        (track): track is MediaStreamTrack => Boolean(track),
      );

      let stream = remoteStreamsRef.current.get(peerId);
      if (!stream) {
        stream = new MediaStream();
        remoteStreamsRef.current.set(peerId, stream);
      }
      const liveIds = new Set(tracks.map((track) => track.id));
      for (const oldTrack of stream.getTracks()) {
        if (!liveIds.has(oldTrack.id)) stream.removeTrack(oldTrack);
      }
      for (const track of tracks) {
        if (!stream.getTrackById(track.id)) stream.addTrack(track);
      }

      if (audioTracks.length) {
        const audio = ensureRemoteAudio(peerId);
        const currentIds = (audio.srcObject as MediaStream | null)
          ?.getAudioTracks()
          .map((track) => track.id)
          .sort()
          .join("|");
        const nextIds = audioTracks
          .map((track) => track.id)
          .sort()
          .join("|");
        if (currentIds !== nextIds) {
          audio.srcObject = new MediaStream(audioTracks);
        }
        audio.muted = deafenedRef.current;
        void audio.play().catch(() => undefined);
      }
      publishRemoteStreams();
    },
    [ensureRemoteAudio, publishRemoteStreams],
  );

  const scheduleRemoteSync = useCallback(
    (peerId: string) => {
      const previous = remoteSyncTimersRef.current.get(peerId);
      if (previous) {
        for (const timer of previous) clearTimeout(timer);
      }
      const timers = new Set<ReturnType<typeof setTimeout>>();
      remoteSyncTimersRef.current.set(peerId, timers);
      for (const delay of MEDIA_SYNC_DELAYS_MS) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          syncRemoteStream(peerId);
          if (!timers.size) remoteSyncTimersRef.current.delete(peerId);
        }, delay);
        timers.add(timer);
      }
    },
    [syncRemoteStream],
  );

  const emitMediaToServer = useCallback(
    (patch: { cameraOff?: boolean; sharingScreen?: boolean }) => {
      socket?.emit("voice:media", patch);
    },
    [socket],
  );

  const emitSignal = useCallback(
    (toUserId: string, type: string, data?: unknown) => {
      const channelId = channelIdRef.current;
      if (!socket || !channelId) return;
      socket.emit("voice:signal", { channelId, toUserId, type, data });
    },
    [socket],
  );

  const scheduleMediaRecovery = useCallback(
    (peerId: string, revision = -1) => {
      const previous = mediaRecoveryTimersRef.current.get(peerId);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        mediaRecoveryTimersRef.current.delete(peerId);
        void (async () => {
          const pc = pcsRef.current.get(peerId);
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
          const last = lastMediaRequestRef.current.get(peerId);
          if (
            last?.revision === revision &&
            Date.now() - last.at < 12_000
          ) {
            return;
          }
          lastMediaRequestRef.current.set(peerId, {
            revision,
            at: Date.now(),
          });
          emitSignal(peerId, "media-request");
        })();
      }, 1800);
      mediaRecoveryTimersRef.current.set(peerId, timer);
    },
    [emitSignal],
  );

  const cleanupPeer = useCallback(
    (peerId: string) => {
      const pc = pcsRef.current.get(peerId);
      if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onnegotiationneeded = null;
        pc.close();
        pcsRef.current.delete(peerId);
      }
      const negotiationTimer = negotiationTimersRef.current.get(peerId);
      if (negotiationTimer) {
        clearTimeout(negotiationTimer);
        negotiationTimersRef.current.delete(peerId);
      }
      negotiationPendingRef.current.delete(peerId);
      iceRestartPeersRef.current.delete(peerId);
      const iceRestartTimer = iceRestartTimersRef.current.get(peerId);
      if (iceRestartTimer) {
        clearTimeout(iceRestartTimer);
        iceRestartTimersRef.current.delete(peerId);
      }
      iceRestartAttemptsRef.current.delete(peerId);
      const remoteSyncTimers = remoteSyncTimersRef.current.get(peerId);
      if (remoteSyncTimers) {
        for (const timer of remoteSyncTimers) clearTimeout(timer);
        remoteSyncTimersRef.current.delete(peerId);
      }
      const audio = remoteAudioRef.current.get(peerId);
      if (audio) {
        audio.srcObject = null;
        audio.remove();
        remoteAudioRef.current.delete(peerId);
      }
      remoteStreamsRef.current.delete(peerId);
      pendingIceRef.current.delete(peerId);
      signalQueueRef.current.delete(peerId);
      makingOfferRef.current.delete(peerId);
      const mediaRecoveryTimer = mediaRecoveryTimersRef.current.get(peerId);
      if (mediaRecoveryTimer) clearTimeout(mediaRecoveryTimer);
      mediaRecoveryTimersRef.current.delete(peerId);
      lastMediaRequestRef.current.delete(peerId);
      publishRemoteStreams();
    },
    [publishRemoteStreams],
  );

  const cleanupAll = useCallback(() => {
    const filter = noiseFilterRef.current;
    noiseFilterRef.current = null;
    void stopNoiseFilter(filter);
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    screenAudioTrackRef.current?.stop();
    screenAudioTrackRef.current = null;
    cameraTrackRef.current?.stop();
    cameraTrackRef.current = null;
    cameraWasOffRef.current = true;
    for (const peerId of [...pcsRef.current.keys()]) cleanupPeer(peerId);
    const stream = localStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStreams({});
    setCameraOff(true);
    setSharingScreen(false);
    setPeerMediaHints({});
    mediaBusyRef.current = false;
    setMediaBusy(false);
    lastRemoteStreamsSignatureRef.current = "";
    try {
      localSourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    localSourceRef.current = null;
    localAnalyserRef.current = null;
    localAnalyserTrackIdRef.current = null;
    try {
      void audioCtxRef.current?.close();
    } catch {
      /* ignore */
    }
    audioCtxRef.current = null;
    speakingRef.current = false;
    speakHoldUntilRef.current = 0;
    setSelfSpeaking(false);
    channelIdRef.current = null;
  }, [cleanupPeer]);

  const ensureIceServers = useCallback(async () => {
    if (iceServersRef.current.length) return iceServersRef.current;
    const servers = await getClientIceServers(tokenRef.current);
    iceServersRef.current = servers;
    return servers;
  }, []);

  const isOfferInitiator = useCallback(
    (peerId: string) => Boolean(selfId && String(selfId) < String(peerId)),
    [selfId],
  );

  const queueNegotiation = useCallback(
    (peerId: string, options?: { iceRestart?: boolean; delay?: number }) => {
      // Only the lexicographically smaller peer creates offers. The other
      // side answers — this avoids glare deadlocks (esp. without rollback).
      if (!isOfferInitiator(peerId)) {
        if (options?.iceRestart) emitSignal(peerId, "media-request");
        return;
      }

      negotiationPendingRef.current.add(peerId);
      if (options?.iceRestart) iceRestartPeersRef.current.add(peerId);

      const schedule = (delay: number) => {
        if (negotiationTimersRef.current.has(peerId)) return;
        const timer = setTimeout(async () => {
          negotiationTimersRef.current.delete(peerId);
          const pc = pcsRef.current.get(peerId);
          if (!pc || pc.signalingState === "closed") {
            negotiationPendingRef.current.delete(peerId);
            iceRestartPeersRef.current.delete(peerId);
            return;
          }
          if (
            makingOfferRef.current.has(peerId) ||
            pc.signalingState !== "stable"
          ) {
            schedule(120);
            return;
          }

          negotiationPendingRef.current.delete(peerId);
          const iceRestart = iceRestartPeersRef.current.has(peerId);
          makingOfferRef.current.add(peerId);
          try {
            optimizePeerConnection(pc);
            const offer = await pc.createOffer({ iceRestart });
            if (pcsRef.current.get(peerId) !== pc) return;
            await pc.setLocalDescription(offer);
            if (iceRestart) iceRestartPeersRef.current.delete(peerId);
            emitSignal(peerId, "offer", offer);
          } catch {
            if (pcsRef.current.get(peerId) === pc) {
              negotiationPendingRef.current.add(peerId);
            }
          } finally {
            makingOfferRef.current.delete(peerId);
            if (negotiationPendingRef.current.has(peerId)) schedule(120);
          }
        }, delay);
        negotiationTimersRef.current.set(peerId, timer);
      };

      schedule(options?.delay ?? 60);
    },
    [emitSignal, isOfferInitiator],
  );

  const queueNegotiationForAll = useCallback(() => {
    for (const peerId of pcsRef.current.keys()) queueNegotiation(peerId);
  }, [queueNegotiation]);

  const refreshLocalVideoForPeer = useCallback(
    async (peerId: string) => {
      const pc = pcsRef.current.get(peerId);
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
      if (!screen && !camera) return;

      const media = new MediaStream([
        ...(localStreamRef.current?.getAudioTracks() || []),
        ...([camera, screen].filter(Boolean) as MediaStreamTrack[]),
      ]);
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
        }
        queueNegotiation(peerId, { delay: 0 });
        emitMediaToServer({
          cameraOff: !camera,
          sharingScreen: Boolean(screen),
        });
      } catch {
        queueNegotiation(peerId, { iceRestart: true, delay: 0 });
      }
    },
    [emitMediaToServer, queueNegotiation],
  );

  const ensurePc = useCallback(
    (peerId: string) => {
      let pc = pcsRef.current.get(peerId);
      if (pc) return pc;
      pc = new RTCPeerConnection({
        iceServers: iceServersRef.current,
        iceCandidatePoolSize: 2,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      });
      const local = localStreamRef.current;
      if (local) {
        for (const track of local.getTracks()) {
          pc.addTrack(track, local);
        }
      }
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          emitSignal(peerId, "ice", event.candidate.toJSON());
        }
      };
      pc.onnegotiationneeded = () => {
        // Initial offer comes only from connectToPeer. Renegotiate
        // (camera/screen) only after the link is up, and only as initiator.
        if (!isOfferInitiator(peerId)) return;
        if (pc.connectionState !== "connected") return;
        queueNegotiation(peerId);
      };
      pc.ontrack = (event) => {
        event.track.onended = () => {
          syncRemoteStream(peerId);
        };
        event.track.onmute = () => syncRemoteStream(peerId, event.track);
        event.track.onunmute = () => syncRemoteStream(peerId, event.track);
        syncRemoteStream(peerId, event.track);
        scheduleRemoteSync(peerId);
      };
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "connected") {
          const timer = iceRestartTimersRef.current.get(peerId);
          if (timer) clearTimeout(timer);
          iceRestartTimersRef.current.delete(peerId);
          iceRestartAttemptsRef.current.delete(peerId);
          syncRemoteStream(peerId);
          const audio = remoteAudioRef.current.get(peerId);
          if (audio && !deafenedRef.current) {
            void audio.play().catch(() => undefined);
          }
          return;
        }
        if (state !== "disconnected" && state !== "failed") return;
        const restart = () => {
          iceRestartTimersRef.current.delete(peerId);
          if (
            pcsRef.current.get(peerId) !== pc ||
            (pc.connectionState !== "disconnected" &&
              pc.connectionState !== "failed")
          ) {
            return;
          }
          const attempts = iceRestartAttemptsRef.current.get(peerId) || 0;
          if (attempts >= MAX_ICE_RESTARTS) {
            cleanupPeer(peerId);
            return;
          }
          iceRestartAttemptsRef.current.set(peerId, attempts + 1);
          if (isOfferInitiator(peerId)) {
            queueNegotiation(peerId, { iceRestart: true, delay: 0 });
          } else {
            emitSignal(peerId, "media-request");
          }
          const retryTimer = setTimeout(
            restart,
            ICE_RESTART_DELAY_MS * (attempts + 2),
          );
          iceRestartTimersRef.current.set(peerId, retryTimer);
        };
        const existing = iceRestartTimersRef.current.get(peerId);
        if (existing) clearTimeout(existing);
        if (state === "failed") {
          restart();
        } else {
          const timer = setTimeout(restart, ICE_RESTART_DELAY_MS);
          iceRestartTimersRef.current.set(peerId, timer);
        }
      };
      pcsRef.current.set(peerId, pc);
      return pc;
    },
    [
      cleanupPeer,
      emitSignal,
      isOfferInitiator,
      queueNegotiation,
      scheduleRemoteSync,
      syncRemoteStream,
    ],
  );

  const connectToPeer = useCallback(
    async (peerId: string) => {
      if (!selfId || peerId === selfId) return;
      const existing = pcsRef.current.get(peerId);
      if (existing) {
        // PC may have been created by an inbound offer path without a
        // completed connection — initiator should (re)offer.
        if (
          isOfferInitiator(peerId) &&
          existing.signalingState === "stable" &&
          existing.connectionState !== "connected" &&
          existing.connectionState !== "connecting"
        ) {
          queueNegotiation(peerId, { delay: 0 });
        }
        return;
      }
      const pc = ensurePc(peerId);
      // One deterministic initiator avoids initial offer glare and duplicate
      // video transceivers on mobile Chromium/WebKit.
      if (!isOfferInitiator(peerId)) return;
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
      makingOfferRef.current.add(peerId);
      try {
        optimizePeerConnection(pc);
        const offer = await pc.createOffer();
        if (pc.signalingState !== "stable") {
          negotiationPendingRef.current.add(peerId);
          return;
        }
        await pc.setLocalDescription(offer);
        emitSignal(peerId, "offer", offer);
        if (cameraWasOffRef.current || !cameraTrackRef.current?.enabled) {
          emitSignal(peerId, "camera-off");
        }
      } catch {
        if (pcsRef.current.get(peerId) === pc) {
          negotiationPendingRef.current.add(peerId);
        }
      } finally {
        makingOfferRef.current.delete(peerId);
        if (negotiationPendingRef.current.has(peerId)) {
          queueNegotiation(peerId, { delay: 120 });
        }
      }
    },
    [emitSignal, ensurePc, isOfferInitiator, queueNegotiation, selfId],
  );

  const stopScreenShare = useCallback(async () => {
    const screen = screenTrackRef.current;
    const screenAudio = screenAudioTrackRef.current;
    if (screen) screen.onended = null;
    screenTrackRef.current = null;
    screenAudioTrackRef.current = null;
    if (screen?.readyState === "live") screen.stop();

    for (const pc of pcsRef.current.values()) {
      await detachLocalVideoTrackByHint(pc, "detail");
      await detachLocalScreenAudioTrack(pc, screenAudio);
    }
    screenAudio?.stop();

    const audioTracks = (localStreamRef.current?.getAudioTracks() || []).filter(
      (track) => track !== screenAudio,
    );
    const camera = cameraTrackRef.current;
    const videos = [camera].filter(
      (track): track is MediaStreamTrack =>
        Boolean(track && track.readyState === "live"),
    );
    const media = new MediaStream([...audioTracks, ...videos]);
    localStreamRef.current = media;
    setLocalStream(media);
    setSharingScreen(false);
    setCameraOff(!camera || camera.readyState !== "live" || !camera.enabled);
    queueNegotiationForAll();
    emitMediaToServer({
      sharingScreen: false,
      cameraOff: !camera || camera.readyState !== "live" || !camera.enabled,
    });
  }, [emitMediaToServer, queueNegotiationForAll]);

  const stopMedia = useCallback(() => {
    cleanupAll();
    setActive(null);
    setPeers([]);
    setMuted(false);
    setDeafened(false);
    setMinimized(false);
    mutedRef.current = false;
    deafenedRef.current = false;
    setError(null);
  }, [cleanupAll]);

  const leave = useCallback(() => {
    if (!managedPresence) socket?.emit("voice:leave");
    stopMedia();
  }, [managedPresence, socket, stopMedia]);

  const startMedia = useCallback(
    async (
      channelId: string,
      groupId: string,
      title: string,
      peers: VoiceChannelUser[] = [],
      opts?: {
        preserveControls?: boolean;
        muted?: boolean;
        deafened?: boolean;
        cameraOff?: boolean;
        sharingScreen?: boolean;
      },
    ) => {
      if (!socket || !selfId) return;
      if (callBusy) {
        setError("Сначала завершите звонок");
        return;
      }
      if (channelIdRef.current === channelId && localStreamRef.current) {
        setPeers(peers);
        for (const peer of peers) {
          if (!pcsRef.current.has(peer.userId)) {
            void connectToPeer(peer.userId);
          }
        }
        return;
      }
      setJoining(true);
      setError(null);
      try {
        if (channelIdRef.current) stopMedia();
        await ensureIceServers();
        const { filter, stream } = await captureFilteredMic();
        noiseFilterRef.current = filter;
        setNoiseFilterEnabled(getKrispEnabled());
        setNoiseFilterKind(filter.kind);
        const keepMuted =
          opts?.muted ?? (opts?.preserveControls ? mutedRef.current : false);
        const keepDeafened =
          opts?.deafened ??
          (opts?.preserveControls ? deafenedRef.current : false);
        const keepCameraOff =
          opts?.cameraOff ??
          (opts?.preserveControls ? cameraWasOffRef.current : true);
        if (keepMuted) {
          setMicEnabled(stream, false, filter.sourceTrack);
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
        mutedRef.current = keepMuted;
        deafenedRef.current = keepDeafened;
        setMuted(keepMuted);
        setDeafened(keepDeafened);
        setCameraOff(keepCameraOff);
        setSharingScreen(false);
        cameraWasOffRef.current = keepCameraOff;
        cameraTrackRef.current = null;
        screenTrackRef.current = null;
        screenAudioTrackRef.current = null;
        channelIdRef.current = channelId;
        setMinimized(false);
        speakingRef.current = false;
        setActive({ channelId, groupId, title });
        setPeers(peers);
        for (const peer of peers) {
          void connectToPeer(peer.userId);
        }
        if (!keepCameraOff) {
          try {
            const cam = await navigator.mediaDevices.getUserMedia({
              video: CAMERA_VIDEO_CONSTRAINTS,
              audio: false,
            });
            const track = cam.getVideoTracks()[0];
            if (track) {
              prepareCameraTrack(track);
              track.enabled = true;
              cameraTrackRef.current = track;
              cameraWasOffRef.current = false;
              setCameraOff(false);
              const media = new MediaStream([
                ...stream.getAudioTracks(),
                track,
              ]);
              localStreamRef.current = media;
              setLocalStream(media);
              for (const pc of pcsRef.current.values()) {
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
              }
              queueNegotiationForAll();
            }
          } catch {
            setCameraOff(true);
            cameraWasOffRef.current = true;
          }
        }
        // Screen share needs a fresh user gesture after topology migrate.
        void opts?.sharingScreen;
      } catch {
        stopMedia();
        setError("Нет доступа к микрофону");
        throw new Error("Нет доступа к микрофону");
      } finally {
        setJoining(false);
      }
    },
    [
      callBusy,
      connectToPeer,
      ensureIceServers,
      queueNegotiationForAll,
      selfId,
      socket,
      stopMedia,
    ],
  );

  const join = useCallback(
    async (channelId: string, groupId: string, title: string) => {
      if (!socket || !selfId) return;
      if (callBusy) {
        setError("Сначала завершите звонок");
        return;
      }
      if (channelIdRef.current === channelId) return;
      const result = await new Promise<{
        ok?: boolean;
        peers?: VoiceChannelUser[];
        error?: string;
      }>((resolve) => {
        socket.emit("voice:join", { channelId }, resolve);
      });
      if (!result?.ok) {
        setError(result?.error || "Не удалось войти в канал");
        return;
      }
      try {
        await startMedia(channelId, groupId, title, result.peers || []);
      } catch {
        if (!managedPresence) socket.emit("voice:leave");
      }
    },
    [callBusy, managedPresence, selfId, socket, startMedia],
  );

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    setMicEnabled(
      localStreamRef.current,
      !next,
      noiseFilterRef.current?.sourceTrack,
    );
    if (next && speakingRef.current) {
      speakingRef.current = false;
      setSelfSpeaking(false);
      socket?.emit("voice:speaking", { speaking: false });
    }
    socket?.emit("voice:mute", { muted: next });
    if (!next && deafenedRef.current) {
      deafenedRef.current = false;
      setDeafened(false);
      for (const audio of remoteAudioRef.current.values()) {
        audio.muted = false;
        void audio.play().catch(() => undefined);
      }
      socket?.emit("voice:deafen", { deafened: false });
    }
  }, [socket]);

  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    for (const audio of remoteAudioRef.current.values()) {
      audio.muted = next;
      if (!next) void audio.play().catch(() => undefined);
    }
    socket?.emit("voice:deafen", { deafened: next });
    if (next) {
      if (!mutedRef.current) {
        mutedRef.current = true;
        setMuted(true);
        setMicEnabled(
          localStreamRef.current,
          false,
          noiseFilterRef.current?.sourceTrack,
        );
        if (speakingRef.current) {
          speakingRef.current = false;
          setSelfSpeaking(false);
          socket?.emit("voice:speaking", { speaking: false });
        }
        socket?.emit("voice:mute", { muted: true });
      }
    } else if (mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
      setMicEnabled(
        localStreamRef.current,
        true,
        noiseFilterRef.current?.sourceTrack,
      );
      socket?.emit("voice:mute", { muted: false });
    }
  }, [socket]);

  const toggleNoiseFilter = useCallback(() => {
    setKrispEnabled(!getKrispEnabled());
  }, []);

  const applyVoiceSettings = useCallback(
    async (change: VoiceSettingsChange) => {
      if (change.speaker) {
        await Promise.all(
          [...remoteAudioRef.current.values()].map((audio) =>
            applyAudioOutput(audio),
          ),
        );
      }
      setNoiseFilterEnabled(getKrispEnabled());
      if (!change.mic && !change.noise) return;
      if (!localStreamRef.current || !channelIdRef.current) return;
      try {
        const next = await captureFilteredMic();
        try {
          const prev = noiseFilterRef.current;
          const stream = withReplacedAudioTrack(
            localStreamRef.current,
            next.filter.outputTrack,
          );
          if (mutedRef.current) {
            setMicEnabled(stream, false, next.filter.sourceTrack);
          }
          await replaceAudioSenders(
            pcsRef.current.values(),
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
    void applyVoiceSettings(change);
  }), [applyVoiceSettings]);

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

  const toggleCamera = useCallback(async () => {
    if (mediaBusyRef.current) return;
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      const turningOn = cameraOff;
      if (turningOn) {
        let track = cameraTrackRef.current;
        if (!track || track.readyState === "ended") {
          try {
            const cam = await navigator.mediaDevices.getUserMedia({
              video: CAMERA_VIDEO_CONSTRAINTS,
              audio: false,
            });
            track = cam.getVideoTracks()[0];
            if (!track) throw new Error("no-video");
            cameraTrackRef.current = track;
          } catch {
            setCameraOff(true);
            setError("Нет доступа к камере");
            return;
          }
        }

        prepareCameraTrack(track);
        track.enabled = true;
        track.onended = () => {
          if (cameraTrackRef.current !== track) return;
          cameraTrackRef.current = null;
          cameraWasOffRef.current = true;
          setCameraOff(true);
          publishLocalVideos();
          void Promise.all(
            [...pcsRef.current.values()].map((pc) =>
              detachLocalVideoTrackByHint(pc, "motion"),
            ),
          ).finally(() =>
            emitMediaToServer({
              cameraOff: true,
              sharingScreen: Boolean(screenTrackRef.current),
            }),
          );
        };

        const media = publishLocalVideos();
        for (const pc of pcsRef.current.values()) {
          try {
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
          } catch {
            /* local preview remains while peer negotiation recovers */
          }
        }
        cameraWasOffRef.current = false;
        setCameraOff(false);
        queueNegotiationForAll();
        emitMediaToServer({
          cameraOff: false,
          sharingScreen: Boolean(screenTrackRef.current),
        });
        return;
      }

      if (cameraTrackRef.current) {
        cameraTrackRef.current.stop();
        cameraTrackRef.current = null;
      }
      cameraWasOffRef.current = true;
      for (const pc of pcsRef.current.values()) {
        await detachLocalVideoTrackByHint(pc, "motion");
      }
      publishLocalVideos();
      setCameraOff(true);
      emitMediaToServer({
        cameraOff: true,
        sharingScreen: Boolean(screenTrackRef.current),
      });
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  }, [
    cameraOff,
    emitMediaToServer,
    publishLocalVideos,
    queueNegotiationForAll,
  ]);

  const toggleScreenShare = useCallback(async () => {
    if (mediaBusyRef.current) return;
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      if (sharingScreen) {
        await stopScreenShare();
        return;
      }

      const display = await captureScreenShare();
      const track = display.getVideoTracks()[0];
      if (!track) {
        display.getTracks().forEach((item) => item.stop());
        setError("Демонстрация экрана недоступна");
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
      for (const pc of pcsRef.current.values()) {
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
        if (screenAudio) {
          await attachLocalScreenAudioTrack(pc, screenAudio, media);
        }
      }

      setSharingScreen(true);
      queueNegotiationForAll();
      emitMediaToServer({
        sharingScreen: true,
        cameraOff,
      });

      track.onended = () => {
        if (screenTrackRef.current !== track) return;
        const restore = () => {
          if (mediaBusyRef.current) {
            setTimeout(restore, 120);
            return;
          }
          mediaBusyRef.current = true;
          setMediaBusy(true);
          void stopScreenShare().finally(() => {
            mediaBusyRef.current = false;
            setMediaBusy(false);
          });
        };
        restore();
      };
    } catch (err) {
      screenTrackRef.current?.stop();
      screenTrackRef.current = null;
      screenAudioTrackRef.current?.stop();
      screenAudioTrackRef.current = null;
      const name =
        err && typeof err === "object" && "name" in err
          ? String((err as { name?: string }).name)
          : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setError("Демонстрация экрана отклонена");
      } else {
        setError("Демонстрация экрана недоступна");
      }
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  }, [
    cameraOff,
    emitMediaToServer,
    publishLocalVideos,
    queueNegotiationForAll,
    sharingScreen,
    stopScreenShare,
  ]);

  useEffect(() => {
    if (!socket || !active) return;

    const samples = createSpeakingSamples();
    const stopTicker = startSpeakingTicker(() => {
      try {
        if (mutedRef.current) {
          if (speakingRef.current) {
            speakingRef.current = false;
            setSelfSpeaking(false);
            socket.emit("voice:speaking", { speaking: false });
          }
          return;
        }
        const track = pickSpeakingTrack(
          noiseFilterRef.current?.sourceTrack,
          localStreamRef.current,
        );
        if (!track) return;
        if (!audioCtxRef.current) {
          const Ctx =
            window.AudioContext ||
            (window as unknown as {
              webkitAudioContext: typeof AudioContext;
            }).webkitAudioContext;
          audioCtxRef.current = new Ctx();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === "suspended") void ctx.resume();
        if (
          localAnalyserTrackIdRef.current !== track.id ||
          !localAnalyserRef.current ||
          !localSourceRef.current
        ) {
          try {
            localSourceRef.current?.disconnect();
          } catch {
            /* ignore */
          }
          localSourceRef.current = ctx.createMediaStreamSource(
            new MediaStream([track]),
          );
          localAnalyserRef.current = ctx.createAnalyser();
          configureSpeakingAnalyser(localAnalyserRef.current);
          localSourceRef.current.connect(localAnalyserRef.current);
          localAnalyserTrackIdRef.current = track.id;
        }
        const level = speakingLevelFromAnalyser(
          localAnalyserRef.current,
          samples,
        );
        const now = Date.now();
        if (level > SPEAKING_THRESHOLD) {
          speakHoldUntilRef.current = now + SPEAKING_HOLD_MS;
        }
        const speaking = now < speakHoldUntilRef.current;
        if (speaking !== speakingRef.current) {
          speakingRef.current = speaking;
          setSelfSpeaking(speaking);
          socket.emit("voice:speaking", { speaking });
        }
      } catch {
        /* analyser soft-fail */
      }
    });

    return () => {
      stopTicker();
      if (speakingRef.current) {
        speakingRef.current = false;
        setSelfSpeaking(false);
        socket.emit("voice:speaking", { speaking: false });
      }
    };
  }, [active, socket]);

  useEffect(() => {
    if (!active) return;
    const publish = () => {
      emitMediaToServer({ cameraOff, sharingScreen });
    };
    publish();
    const timer = setInterval(publish, 5000);
    return () => clearInterval(timer);
  }, [active, cameraOff, emitMediaToServer, sharingScreen]);

  useEffect(() => {
    if (!active) return;
    const resumeMedia = () => {
      if (document.visibilityState === "hidden") return;
      for (const [peerId, audio] of remoteAudioRef.current.entries()) {
        if (!deafenedRef.current) void audio.play().catch(() => undefined);
        scheduleRemoteSync(peerId);
      }
    };
    document.addEventListener("visibilitychange", resumeMedia);
    window.addEventListener("online", resumeMedia);
    window.addEventListener("pointerdown", resumeMedia, { capture: true });
    return () => {
      document.removeEventListener("visibilitychange", resumeMedia);
      window.removeEventListener("online", resumeMedia);
      window.removeEventListener("pointerdown", resumeMedia, { capture: true });
    };
  }, [active, scheduleRemoteSync]);

  useEffect(() => {
    if (!socket) return;

    function patchPeerMedia(
      userId: string,
      patch: {
        cameraOff?: boolean;
        sharingScreen?: boolean;
        mediaRevision?: number;
      },
    ) {
      setPeerMediaHints((prev) => {
        const current = prev[userId];
        const currentRevision = current?.mediaRevision;
        const nextRevision = patch.mediaRevision;
        if (nextRevision === undefined && currentRevision !== undefined) {
          return prev;
        }
        if (
          nextRevision !== undefined &&
          currentRevision !== undefined &&
          nextRevision < currentRevision
        ) {
          return prev;
        }
        return {
          ...prev,
          [userId]: { ...current, ...patch },
        };
      });
    }

    function onMedia(payload: {
      channelId?: string;
      userId?: string;
      cameraOff?: boolean;
      sharingScreen?: boolean;
      mediaRevision?: number;
    }) {
      if (
        payload.channelId !== channelIdRef.current ||
        !payload.userId ||
        payload.userId === selfId
      ) {
        return;
      }
      patchPeerMedia(payload.userId, {
        cameraOff: payload.cameraOff,
        sharingScreen: payload.sharingScreen,
        mediaRevision: payload.mediaRevision,
      });
      if (!pcsRef.current.has(payload.userId)) {
        void connectToPeer(payload.userId);
      }
      scheduleRemoteSync(payload.userId);
      if (payload.cameraOff === false || payload.sharingScreen === true) {
        scheduleMediaRecovery(payload.userId, payload.mediaRevision);
      } else {
        const recoveryTimer = mediaRecoveryTimersRef.current.get(payload.userId);
        if (recoveryTimer) clearTimeout(recoveryTimer);
        mediaRecoveryTimersRef.current.delete(payload.userId);
      }
    }

    function onSignal(payload: {
      channelId?: string;
      fromUserId?: string;
      type?: string;
      data?: RTCSessionDescriptionInit | RTCIceCandidateInit;
    }) {
      const channelId = channelIdRef.current;
      if (!channelId || payload.channelId !== channelId) return;
      const fromUserId = String(payload.fromUserId || "");
      if (!fromUserId || fromUserId === selfId) return;
      const type = String(payload.type || "");

      if (type === "media-request") {
        const pc = pcsRef.current.get(fromUserId);
        if (
          isOfferInitiator(fromUserId) &&
          pc &&
          pc.connectionState !== "connected"
        ) {
          queueNegotiation(fromUserId, { iceRestart: true, delay: 0 });
        }
        void refreshLocalVideoForPeer(fromUserId);
        return;
      }

      if (type === "screen-on") {
        patchPeerMedia(fromUserId, { sharingScreen: true, cameraOff: true });
        scheduleRemoteSync(fromUserId);
        return;
      }
      if (type === "screen-off") {
        patchPeerMedia(fromUserId, { sharingScreen: false });
        scheduleRemoteSync(fromUserId);
        return;
      }
      if (type === "camera-on") {
        patchPeerMedia(fromUserId, { cameraOff: false, sharingScreen: false });
        scheduleRemoteSync(fromUserId);
        return;
      }
      if (type === "camera-off") {
        patchPeerMedia(fromUserId, { cameraOff: true });
        scheduleRemoteSync(fromUserId);
        return;
      }

      const previous =
        signalQueueRef.current.get(fromUserId) || Promise.resolve();
      const task = previous.catch(() => undefined).then(async () => {
        try {
          if (type === "offer") {
            const pc = ensurePc(fromUserId);
            // Perfect-negotiation glare rule: only the polite side rolls
            // back; the impolite side ignores the colliding offer so one
            // of the two offers always completes.
            const offerCollision =
              makingOfferRef.current.has(fromUserId) ||
              pc.signalingState === "have-local-offer";
            const polite = String(selfId) < fromUserId;
            if (offerCollision && !polite) return;
            if (pc.signalingState === "have-local-offer") {
              await pc.setLocalDescription({ type: "rollback" });
            }
            await pc.setRemoteDescription(
              payload.data as RTCSessionDescriptionInit,
            );
            optimizePeerConnection(pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            emitSignal(fromUserId, "answer", answer);
            const buffered = pendingIceRef.current.get(fromUserId) || [];
            pendingIceRef.current.delete(fromUserId);
            for (const ice of buffered) {
              await pc.addIceCandidate(ice).catch(() => undefined);
            }
            scheduleRemoteSync(fromUserId);
            if (negotiationPendingRef.current.has(fromUserId)) {
              queueNegotiation(fromUserId, { delay: 120 });
            }
            return;
          }
          if (type === "answer") {
            const pc = pcsRef.current.get(fromUserId);
            if (!pc) return;
            if (pc.signalingState === "stable") return;
            await pc.setRemoteDescription(
              payload.data as RTCSessionDescriptionInit,
            );
            const buffered = pendingIceRef.current.get(fromUserId) || [];
            pendingIceRef.current.delete(fromUserId);
            for (const ice of buffered) {
              await pc.addIceCandidate(ice);
            }
            scheduleRemoteSync(fromUserId);
            if (negotiationPendingRef.current.has(fromUserId)) {
              queueNegotiation(fromUserId, { delay: 120 });
            }
            return;
          }
          if (type === "ice") {
            const ice = payload.data as RTCIceCandidateInit;
            const pc = pcsRef.current.get(fromUserId);
            if (!pc || !pc.remoteDescription) {
              const list = pendingIceRef.current.get(fromUserId) || [];
              list.push(ice);
              pendingIceRef.current.set(fromUserId, list);
              return;
            }
            await pc.addIceCandidate(ice);
          }
        } catch {
          /* soft-fail WebRTC */
        }
      });
      signalQueueRef.current.set(fromUserId, task);
      void task.finally(() => {
        if (signalQueueRef.current.get(fromUserId) === task) {
          signalQueueRef.current.delete(fromUserId);
        }
      });
    }

    function onState(payload: {
      groupId?: string;
      channels?: {
        id: string;
        title: string;
        users: VoiceChannelUser[];
      }[];
    }) {
      const channelId = channelIdRef.current;
      if (!channelId || !payload.channels) return;
      const channel = payload.channels.find((item) => item.id === channelId);
      if (!channel) {
        if (!managedPresence) {
          cleanupAll();
          setActive(null);
          setPeers([]);
          setMinimized(false);
        }
        return;
      }
      setPeers(channel.users.filter((user) => user.userId !== selfId));
      setPeerMediaHints((prev) => {
        const next: typeof prev = {};
        for (const user of channel.users) {
          if (user.userId === selfId) continue;
          const hint = prev[user.userId];
          const serverRevision = user.mediaRevision ?? -1;
          if (hint && (hint.mediaRevision ?? -1) > serverRevision) {
            next[user.userId] = hint;
          } else {
            next[user.userId] = {
              cameraOff: user.cameraOff ?? true,
              sharingScreen: user.sharingScreen ?? false,
              mediaRevision: user.mediaRevision,
            };
          }
        }
        return next;
      });
      const alive = new Set(
        channel.users.map((user) => user.userId).filter((id) => id !== selfId),
      );
      for (const peerId of [...pcsRef.current.keys()]) {
        if (!alive.has(peerId)) cleanupPeer(peerId);
      }
      for (const user of channel.users) {
        if (user.userId === selfId) continue;
        if (!pcsRef.current.has(user.userId)) {
          void connectToPeer(user.userId);
        }
      }
    }

    function onKick(payload: { channelId?: string; reason?: string }) {
      if (!payload?.channelId || payload.channelId !== channelIdRef.current) {
        return;
      }
      cleanupAll();
      setActive(null);
      setPeers([]);
      setMuted(false);
      setDeafened(false);
      setMinimized(false);
      mutedRef.current = false;
      deafenedRef.current = false;
      if (payload.reason === "takeover") {
        setError("Вы подключились к каналу с другой вкладки");
      }
    }

    socket.on("voice:signal", onSignal);
    socket.on("voice:media", onMedia);
    socket.on("voice:state", onState);
    socket.on("voice:kick", onKick);
    return () => {
      socket.off("voice:signal", onSignal);
      socket.off("voice:media", onMedia);
      socket.off("voice:state", onState);
      socket.off("voice:kick", onKick);
    };
  }, [
    cleanupAll,
    cleanupPeer,
    connectToPeer,
    emitSignal,
    ensurePc,
    isOfferInitiator,
    queueNegotiation,
    refreshLocalVideoForPeer,
    scheduleMediaRecovery,
    managedPresence,
    scheduleRemoteSync,
    selfId,
    socket,
  ]);

  useEffect(() => {
    return () => {
      cleanupAll();
    };
  }, [cleanupAll]);

  useEffect(() => {
    if (!callBusy || !channelIdRef.current) return;
    const timer = setTimeout(() => {
      if (managedPresence) stopMedia();
      else leave();
    }, 0);
    return () => clearTimeout(timer);
  }, [callBusy, leave, managedPresence, stopMedia]);

  const peersWithMedia = peers.map((peer) => {
    const hint = peerMediaHints[peer.userId];
    return {
      ...peer,
      cameraOff: hint?.cameraOff ?? peer.cameraOff ?? true,
      sharingScreen: hint?.sharingScreen ?? peer.sharingScreen ?? false,
    };
  });

  const setPeersExternal = useCallback((next: VoiceChannelUser[]) => {
    setPeers(next);
    for (const peer of next) {
      if (!pcsRef.current.has(peer.userId)) {
        void connectToPeer(peer.userId);
      }
    }
    const alive = new Set(next.map((peer) => peer.userId));
    for (const peerId of [...pcsRef.current.keys()]) {
      if (!alive.has(peerId)) cleanupPeer(peerId);
    }
  }, [cleanupPeer, connectToPeer]);

  return {
    active,
    peers: peersWithMedia,
    muted,
    deafened,
    joining,
    error,
    localStream,
    remoteStreams,
    cameraOff,
    sharingScreen,
    mediaBusy,
    minimized,
    setMinimized,
    join,
    leave,
    startMedia,
    stopMedia,
    setPeersExternal,
    toggleMute,
    toggleDeafen,
    toggleNoiseFilter,
    toggleCamera,
    toggleScreenShare,
    clearError: () => setError(null),
    selfName,
    selfSpeaking,
    noiseFilterEnabled,
    noiseFilterKind,
  };
}
