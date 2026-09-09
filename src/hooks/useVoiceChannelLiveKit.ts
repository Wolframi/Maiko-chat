"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioPresets,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  VideoQuality,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import type { Socket } from "socket.io-client";
import type { VoiceChannelUser } from "@/lib/types";
import {
  attachNoiseFilterToLiveKitTrack,
  audioCaptureConstraints,
  getKrispEnabled,
  getNoiseFilterPref,
  setKrispEnabled,
  stopNoiseFilter,
  type NoiseFilterKind,
  type NoiseFilterSession,
} from "@/lib/noiseFilter";
import {
  applyAudioOutput,
  getMicDeviceId,
  getSpeakerDeviceId,
  subscribeVoiceSettings,
  type VoiceSettingsChange,
} from "@/lib/mediaDevices";
import {
  configureSpeakingAnalyser,
  createSpeakingSamples,
  pickSpeakingTrack,
  speakingLevelFromAnalyser,
  SPEAKING_HOLD_MS,
  SPEAKING_THRESHOLD,
  startSpeakingTicker,
} from "@/lib/speakingMeter";

type ActiveVoice = {
  channelId: string;
  groupId: string;
  title: string;
};

type UseVoiceChannelOptions = {
  socket: Socket | null;
  selfId?: string;
  selfName?: string;
  token?: string | null;
  callBusy?: boolean;
  /** Presence (voice:join/leave) owned by the group-voice coordinator. */
  managedPresence?: boolean;
};

export type VoiceTopology = "p2p" | "sfu";

type LiveKitTokenResponse = {
  ok?: boolean;
  serverUrl?: string;
  participantToken?: string;
  error?: string;
};

const CAMERA_CAPTURE = {
  resolution: VideoPresets.h720.resolution,
  frameRate: 24,
  facingMode: "user" as const,
};

const SCREEN_SHARE_CAPTURE = {
  audio: true,
  resolution: VideoPresets.h720.resolution,
  contentHint: "detail" as const,
  systemAudio: "include" as const,
  suppressLocalAudioPlayback: true,
};

const SCREEN_SHARE_CAPTURE_SIMPLE = {
  audio: true,
  resolution: VideoPresets.h720.resolution,
  contentHint: "detail" as const,
};

const SCREEN_SHARE_CAPTURE_VIDEO_ONLY = {
  audio: false,
  resolution: VideoPresets.h720.resolution,
  contentHint: "detail" as const,
};

const SCREEN_SHARE_PUBLISH = {
  // Simulcast layers for screen share often never appear on LiveKit 1.8
  // (subscribers get notFoundTimeout / empty stage).
  simulcast: false,
  degradationPreference: "maintain-resolution" as const,
  videoEncoding: {
    maxBitrate: 2_500_000,
    maxFramerate: 24,
  },
};

const ROOM_PUBLISH_DEFAULTS = {
  audioPreset: AudioPresets.speech,
  dtx: true,
  red: false,
  forceStereo: false,
  simulcast: true,
  videoCodec: "vp8" as const,
  videoEncoding: {
    maxBitrate: 1_500_000,
    maxFramerate: 24,
  },
  videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
  screenShareEncoding: {
    maxBitrate: 2_500_000,
    maxFramerate: 24,
  },
  screenShareSimulcastLayers: [],
};

function markAsScreenTrack(track: MediaStreamTrack | undefined) {
  if (!track) return;
  try {
    if (track.contentHint !== "detail" && track.contentHint !== "text") {
      track.contentHint = "detail";
    }
  } catch {
    /* Safari */
  }
}

async function enableLiveKitScreenShare(room: Room) {
  const attempts = [
    SCREEN_SHARE_CAPTURE,
    SCREEN_SHARE_CAPTURE_SIMPLE,
    SCREEN_SHARE_CAPTURE_VIDEO_ONLY,
  ];
  let lastError: unknown;
  for (const capture of attempts) {
    try {
      await room.localParticipant.setScreenShareEnabled(
        true,
        capture,
        SCREEN_SHARE_PUBLISH,
      );
      const live = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShare,
      )?.track?.mediaStreamTrack;
      if (live?.readyState === "live") {
        markAsScreenTrack(live);
        return;
      }
    } catch (error) {
      lastError = error;
      const name = error instanceof Error ? error.name : "";
      if (name === "NotAllowedError" || name === "AbortError") {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("screen-share-failed");
}

function liveKitAudioCapture() {
  const constraints = audioCaptureConstraints();
  const micId = getMicDeviceId();
  return {
    echoCancellation: true as const,
    noiseSuppression: Boolean(constraints.noiseSuppression),
    autoGainControl: true as const,
    channelCount: 1,
    ...(micId ? { deviceId: micId } : {}),
  };
}

export function useVoiceChannelLiveKit({
  socket,
  selfId,
  selfName,
  token = null,
  callBusy = false,
  managedPresence = false,
}: UseVoiceChannelOptions) {
  const [active, setActive] = useState<ActiveVoice | null>(null);
  const [peers, setPeers] = useState<VoiceChannelUser[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, MediaStream>
  >({});
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [cameraOff, setCameraOff] = useState(true);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selfSpeaking, setSelfSpeaking] = useState(false);
  const [noiseFilterEnabled, setNoiseFilterEnabled] = useState(
    getNoiseFilterPref,
  );
  const [noiseFilterKind, setNoiseFilterKind] =
    useState<NoiseFilterKind>("browser");

  const roomRef = useRef<Room | null>(null);
  const activeRef = useRef<ActiveVoice | null>(null);
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const cameraOffRef = useRef(true);
  const sharingScreenRef = useRef(false);
  const mediaBusyRef = useRef(false);
  const audioBusyRef = useRef(false);
  const screenStopBusyRef = useRef(false);
  const joiningRef = useRef(false);
  const joinAttemptRef = useRef(0);
  const joinAbortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const sessionTokenRef = useRef(token);
  const intentionalDisconnectRef = useRef(false);
  const remoteTracksRef = useRef(
    new Map<string, Map<Track.Source, MediaStreamTrack>>(),
  );
  const remoteVideoPubsRef = useRef(
    new Map<string, Map<Track.Source, RemoteTrackPublication>>(),
  );
  const remoteAudioRef = useRef(new Map<string, HTMLAudioElement>());
  const remoteAudioTracksRef = useRef(new Map<string, RemoteTrack>());
  const stopScreenShareRef = useRef<() => Promise<void>>(async () => {});
  const noiseFilterRef = useRef<NoiseFilterSession | null>(null);
  const minimizedRef = useRef(false);
  const startMediaInflightRef = useRef<Promise<void> | null>(null);
  const startMediaRef = useRef<
    | ((
        channelId: string,
        groupId: string,
        title: string,
        peers?: VoiceChannelUser[],
        opts?: {
          preserveControls?: boolean;
          muted?: boolean;
          deafened?: boolean;
          cameraOff?: boolean;
          sharingScreen?: boolean;
        },
      ) => Promise<void>)
    | null
  >(null);
  const peersSnapshotRef = useRef<VoiceChannelUser[]>([]);
  const speakingRef = useRef(false);
  const speakHoldUntilRef = useRef(0);

  const detachRemoteAudio = useCallback((userId: string) => {
    const track = remoteAudioTracksRef.current.get(userId);
    if (track) {
      track.detach().forEach((element) => {
        element.srcObject = null;
        element.remove();
      });
      remoteAudioTracksRef.current.delete(userId);
    }
    const element = remoteAudioRef.current.get(userId);
    if (element) {
      element.srcObject = null;
      element.remove();
      remoteAudioRef.current.delete(userId);
    }
  }, []);

  const attachRemoteAudio = useCallback(
    (userId: string, track: RemoteTrack) => {
      detachRemoteAudio(userId);
      const element = track.attach() as HTMLAudioElement;
      element.autoplay = true;
      element.hidden = true;
      element.setAttribute("playsinline", "");
      element.muted = deafenedRef.current;
      document.body.appendChild(element);
      remoteAudioTracksRef.current.set(userId, track);
      remoteAudioRef.current.set(userId, element);
      void applyAudioOutput(element);
      void roomRef.current?.startAudio().catch(() => undefined);
      if (!element.muted) void element.play().catch(() => undefined);
    },
    [detachRemoteAudio],
  );

  const syncLocalStream = useCallback((room = roomRef.current) => {
    if (!room) {
      setLocalStream(null);
      return;
    }
    const participant = room.localParticipant;
    const screenTrack = participant.getTrackPublication(
      Track.Source.ScreenShare,
    )?.track?.mediaStreamTrack;
    markAsScreenTrack(screenTrack);
    const tracks = [
      participant.getTrackPublication(Track.Source.Microphone)?.track
        ?.mediaStreamTrack,
      screenTrack,
      participant.getTrackPublication(Track.Source.Camera)?.track
        ?.mediaStreamTrack,
    ].filter(
      (track): track is MediaStreamTrack =>
        Boolean(track && track.readyState === "live"),
    );
    setLocalStream(new MediaStream(tracks));
  }, []);

  const syncRemoteStreams = useCallback(() => {
    const next: Record<string, MediaStream> = {};
    for (const [userId, tracksBySource] of remoteTracksRef.current) {
      const screen = tracksBySource.get(Track.Source.ScreenShare);
      const camera = tracksBySource.get(Track.Source.Camera);
      markAsScreenTrack(screen);
      const videos = [camera, screen].filter(
        (track): track is MediaStreamTrack =>
          Boolean(track && track.readyState === "live"),
      );
      if (videos.length) next[userId] = new MediaStream(videos);
    }
    setRemoteStreams(next);
  }, []);

  const cleanupRoom = useCallback(() => {
    const filter = noiseFilterRef.current;
    noiseFilterRef.current = null;
    void stopNoiseFilter(filter);
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      room.removeAllListeners();
      void room.disconnect(true).catch(() => undefined);
    }
    for (const userId of [...remoteAudioTracksRef.current.keys()]) {
      detachRemoteAudio(userId);
    }
    remoteAudioTracksRef.current.clear();
    remoteAudioRef.current.clear();
    remoteTracksRef.current.clear();
    remoteVideoPubsRef.current.clear();
    setLocalStream(null);
    setRemoteStreams({});
  }, [detachRemoteAudio]);

  const resetState = useCallback(() => {
    activeRef.current = null;
    setActive(null);
    setPeers([]);
    setMuted(false);
    setDeafened(false);
    setCameraOff(true);
    setSharingScreen(false);
    setMediaBusy(false);
    setMinimized(false);
    mutedRef.current = false;
    deafenedRef.current = false;
    cameraOffRef.current = true;
    sharingScreenRef.current = false;
    mediaBusyRef.current = false;
    audioBusyRef.current = false;
    screenStopBusyRef.current = false;
    setSelfSpeaking(false);
  }, []);

  const emitMediaState = useCallback(
    (nextCameraOff: boolean, nextSharingScreen: boolean) => {
      socket?.emit("voice:media", {
        cameraOff: nextCameraOff,
        sharingScreen: nextSharingScreen,
      });
    },
    [socket],
  );

  const applyNoiseFilterToRoom = useCallback(async (room: Room) => {
    const publication = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    );
    const track = publication?.track;
    if (!(track instanceof LocalAudioTrack)) return;
    const prev = noiseFilterRef.current;
    noiseFilterRef.current = null;
    await stopNoiseFilter(prev);
    const session = await attachNoiseFilterToLiveKitTrack(track);
    if (roomRef.current !== room) {
      await stopNoiseFilter(session);
      return;
    }
    noiseFilterRef.current = session;
    setNoiseFilterEnabled(getKrispEnabled());
    setNoiseFilterKind(session.kind);
  }, []);

  const applyRemoteVideoQuality = useCallback(() => {
    const hidden =
      typeof document !== "undefined" &&
      (document.visibilityState === "hidden" || minimizedRef.current);
    for (const pubs of remoteVideoPubsRef.current.values()) {
      for (const [source, publication] of pubs) {
        try {
          // Keep screen share subscribed. Disabling it on minimize/tab-hide
          // often comes back as a black frame after LiveKit resubscribe.
          if (source === Track.Source.ScreenShare) {
            publication.setEnabled(true);
            continue;
          }
          if (hidden) {
            publication.setEnabled(false);
            continue;
          }
          publication.setEnabled(true);
          publication.setVideoQuality(VideoQuality.LOW);
        } catch {
          /* publication may already be detached */
        }
      }
    }
  }, []);

  const addRemoteTrack = useCallback(
    (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (publication.source === Track.Source.ScreenShareAudio) {
        attachRemoteAudio(`${participant.identity}::screen`, track);
        return;
      }
      if (
        track.kind === Track.Kind.Audio ||
        publication.source === Track.Source.Microphone
      ) {
        attachRemoteAudio(participant.identity, track);
        return;
      }
      let tracks = remoteTracksRef.current.get(participant.identity);
      if (!tracks) {
        tracks = new Map();
        remoteTracksRef.current.set(participant.identity, tracks);
      }
      if (publication.source === Track.Source.ScreenShare) {
        markAsScreenTrack(track.mediaStreamTrack);
      }
      tracks.set(publication.source, track.mediaStreamTrack);
      let pubs = remoteVideoPubsRef.current.get(participant.identity);
      if (!pubs) {
        pubs = new Map();
        remoteVideoPubsRef.current.set(participant.identity, pubs);
      }
      pubs.set(publication.source, publication);
      applyRemoteVideoQuality();
      syncRemoteStreams();
    },
    [applyRemoteVideoQuality, attachRemoteAudio, syncRemoteStreams],
  );

  const removeRemoteTrack = useCallback(
    (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (publication.source === Track.Source.ScreenShareAudio) {
        const key = `${participant.identity}::screen`;
        const attached = remoteAudioTracksRef.current.get(key);
        if (!attached || attached.sid === track.sid) {
          detachRemoteAudio(key);
        }
        return;
      }
      if (
        track.kind === Track.Kind.Audio ||
        publication.source === Track.Source.Microphone
      ) {
        const attached = remoteAudioTracksRef.current.get(participant.identity);
        if (!attached || attached.sid === track.sid) {
          detachRemoteAudio(participant.identity);
        }
        return;
      }
      const tracks = remoteTracksRef.current.get(participant.identity);
      if (!tracks) return;
      const stored = tracks.get(publication.source);
      if (stored?.id === track.mediaStreamTrack.id) {
        tracks.delete(publication.source);
      }
      if (!tracks.size) remoteTracksRef.current.delete(participant.identity);
      const pubs = remoteVideoPubsRef.current.get(participant.identity);
      pubs?.delete(publication.source);
      if (pubs && !pubs.size) {
        remoteVideoPubsRef.current.delete(participant.identity);
      }
      syncRemoteStreams();
    },
    [detachRemoteAudio, syncRemoteStreams],
  );

  const wireRoom = useCallback(
    (room: Room) => {
      room.on(RoomEvent.TrackSubscribed, addRemoteTrack);
      room.on(RoomEvent.TrackUnsubscribed, removeRemoteTrack);
      room.on(RoomEvent.TrackPublished, (publication) => {
        if (!publication.isSubscribed) {
          publication.setSubscribed(true);
        }
      });
      room.on(RoomEvent.TrackSubscriptionFailed, (_sid, participant) => {
        for (const publication of participant.trackPublications.values()) {
          if (publication.isSubscribed) continue;
          try {
            publication.setSubscribed(true);
            if (publication.source === Track.Source.ScreenShare) {
              publication.setEnabled(true);
            }
          } catch {
            /* publication may already be detached */
          }
        }
      });
      room.on(RoomEvent.TrackMuted, () => syncRemoteStreams());
      room.on(RoomEvent.TrackUnmuted, () => syncRemoteStreams());
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        remoteTracksRef.current.delete(participant.identity);
        remoteVideoPubsRef.current.delete(participant.identity);
        detachRemoteAudio(participant.identity);
        detachRemoteAudio(`${participant.identity}::screen`);
        syncRemoteStreams();
      });
      room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (room.canPlaybackAudio) {
          setError((current) =>
            current === "Нажмите в окно, чтобы включить звук"
              ? null
              : current,
          );
          return;
        }
        setError("Нажмите в окно, чтобы включить звук");
      });
      room.on(RoomEvent.LocalTrackPublished, () => syncLocalStream(room));
      room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
        syncLocalStream(room);
        if (
          publication.source === Track.Source.ScreenShare &&
          sharingScreenRef.current
        ) {
          const stillLive =
            room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
              ?.track?.mediaStreamTrack?.readyState === "live";
          if (!stillLive) void stopScreenShareRef.current();
        }
      });
      room.on(RoomEvent.Reconnecting, () => setError("Переподключение к SFU…"));
      room.on(RoomEvent.Reconnected, () => setError(null));
      room.on(RoomEvent.Disconnected, () => {
        if (intentionalDisconnectRef.current) return;
        // Under the hybrid coordinator, presence stays up — only media dies.
        // Rebind LiveKit so the UI does not sit "in channel" with silence.
        const current = activeRef.current;
        const peers = peersSnapshotRef.current;
        cleanupRoom();
        if (!managedPresence) {
          socket?.emit("voice:leave");
          resetState();
          setError("Соединение с голосовым сервером потеряно");
          return;
        }
        setLocalStream(null);
        setRemoteStreams({});
        joiningRef.current = false;
        setJoining(false);
        setError("Переподключение к SFU…");
        if (current) {
          window.setTimeout(() => {
            if (activeRef.current?.channelId !== current.channelId) return;
            if (roomRef.current) return;
            void startMediaRef.current?.(
              current.channelId,
              current.groupId,
              current.title,
              peers,
              { preserveControls: true },
            );
          }, 600);
        }
      });
    },
    [
      addRemoteTrack,
      cleanupRoom,
      detachRemoteAudio,
      managedPresence,
      removeRemoteTrack,
      resetState,
      socket,
      syncLocalStream,
      syncRemoteStreams,
    ],
  );

  const stopMedia = useCallback(() => {
    joinAttemptRef.current += 1;
    joinAbortRef.current?.abort();
    joinAbortRef.current = null;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    joiningRef.current = false;
    setJoining(false);
    intentionalDisconnectRef.current = true;
    cleanupRoom();
    resetState();
    setError(null);
    queueMicrotask(() => {
      intentionalDisconnectRef.current = false;
    });
  }, [cleanupRoom, resetState]);

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
      if (!socket || !selfId || !token) {
        throw new Error("Сначала войдите в аккаунт");
      }
      if (callBusy) {
        setError("Сначала завершите звонок");
        throw new Error("Сначала завершите звонок");
      }
      if (activeRef.current?.channelId === channelId && roomRef.current) {
        setPeers(peers);
        return;
      }
      const inflight = startMediaInflightRef.current;
      if (joiningRef.current && inflight) {
        await inflight;
        if (activeRef.current?.channelId === channelId && roomRef.current) {
          setPeers(peers);
          return;
        }
      }
      if (activeRef.current) stopMedia();

      const preserve = Boolean(opts?.preserveControls);
      const keepMuted =
        opts?.muted ?? (preserve ? mutedRef.current : false);
      const keepDeafened =
        opts?.deafened ?? (preserve ? deafenedRef.current : false);
      const keepCameraOff =
        opts?.cameraOff ?? (preserve ? cameraOffRef.current : true);
      const keepSharing =
        opts?.sharingScreen ??
        (preserve ? sharingScreenRef.current : false);

      joiningRef.current = true;
      setJoining(true);
      setError(null);
      const attempt = ++joinAttemptRef.current;
      const controller = new AbortController();
      joinAbortRef.current = controller;
      let pendingRoom: Room | null = null;
      let settleInflight = () => {};
      const thisInflight = new Promise<void>((resolve) => {
        settleInflight = resolve;
      });
      startMediaInflightRef.current = thisInflight;

      try {
        const response = await fetch("/api/livekit/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-pulse-token": token,
          },
          body: JSON.stringify({ channelId }),
          signal: controller.signal,
        });
        if (attempt !== joinAttemptRef.current || controller.signal.aborted) {
          const cancelled = new Error("SFU join cancelled");
          cancelled.name = "AbortError";
          throw cancelled;
        }
        const credentials = (await response.json()) as LiveKitTokenResponse;
        if (
          !response.ok ||
          !credentials.serverUrl ||
          !credentials.participantToken
        ) {
          throw new Error(credentials.error || "SFU недоступен");
        }

        const room = new Room({
          adaptiveStream: false,
          dynacast: false,
          // Client 2.x defaults to /rtc/v1 + a giant join_request query.
          // LiveKit 1.8 has no v1 path, and Cloudflare/Node abort huge URLs.
          singlePeerConnection: false,
          audioCaptureDefaults: liveKitAudioCapture(),
          audioOutput: getSpeakerDeviceId()
            ? { deviceId: getSpeakerDeviceId() }
            : undefined,
          videoCaptureDefaults: {
            resolution: VideoPresets.h720.resolution,
            frameRate: 24,
          },
          publishDefaults: ROOM_PUBLISH_DEFAULTS,
          stopLocalTrackOnUnpublish: true,
        });
        pendingRoom = room;
        wireRoom(room);
        roomRef.current = room;
        intentionalDisconnectRef.current = false;
        // Do not pass iceServers here: livekit-client then skips the SFU's own
        // ICE/TURN from the join response (P2P /api/ice would win and group
        // media often never reaches this VM).
        await room.connect(
          credentials.serverUrl,
          credentials.participantToken,
          {
            autoSubscribe: true,
            peerConnectionTimeout: 45_000,
            websocketTimeout: 20_000,
            rtcConfig: {
              iceCandidatePoolSize: 4,
            },
          },
        );
        if (attempt !== joinAttemptRef.current || controller.signal.aborted) {
          const cancelled = new Error("SFU join cancelled");
          cancelled.name = "AbortError";
          throw cancelled;
        }
        await room.startAudio().catch(() => undefined);
        await room.localParticipant.setMicrophoneEnabled(
          !keepMuted,
          liveKitAudioCapture(),
        );
        if (attempt !== joinAttemptRef.current || controller.signal.aborted) {
          const cancelled = new Error("SFU join cancelled");
          cancelled.name = "AbortError";
          throw cancelled;
        }
        await applyNoiseFilterToRoom(room);
        if (attempt !== joinAttemptRef.current || controller.signal.aborted) {
          const cancelled = new Error("SFU join cancelled");
          cancelled.name = "AbortError";
          throw cancelled;
        }
        if (!keepCameraOff) {
          await room.localParticipant
            .setCameraEnabled(true, CAMERA_CAPTURE, { simulcast: true })
            .catch(() => undefined);
        }
        if (keepSharing) {
          await enableLiveKitScreenShare(room).catch(() => undefined);
        }
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) {
            if (!publication.isSubscribed) {
              publication.setSubscribed(true);
            }
            if (publication.isSubscribed && publication.track) {
              addRemoteTrack(
                publication.track,
                publication,
                participant,
              );
            }
          }
        }

        const nextActive = { channelId, groupId, title };
        activeRef.current = nextActive;
        setActive(nextActive);
        setPeers(peers);
        mutedRef.current = keepMuted;
        deafenedRef.current = keepDeafened;
        cameraOffRef.current = keepCameraOff;
        sharingScreenRef.current = keepSharing;
        setMuted(keepMuted);
        setDeafened(keepDeafened);
        setCameraOff(keepCameraOff);
        setSharingScreen(keepSharing);
        syncLocalStream(room);
        emitMediaState(keepCameraOff, keepSharing);
        if (keepMuted) socket.emit("voice:mute", { muted: true });
        if (keepDeafened) socket.emit("voice:deafen", { deafened: true });
      } catch (joinError) {
        if (attempt !== joinAttemptRef.current || controller.signal.aborted) {
          const cancelled = new Error("SFU join cancelled");
          cancelled.name = "AbortError";
          throw cancelled;
        }
        cleanupRoom();
        if (!managedPresence) resetState();
        else {
          setLocalStream(null);
          setRemoteStreams({});
        }
        setError(
          joinError instanceof Error
            ? joinError.message
            : "Не удалось подключиться к SFU",
        );
        throw joinError;
      } finally {
        if (attempt !== joinAttemptRef.current && pendingRoom) {
          if (roomRef.current === pendingRoom) {
            cleanupRoom();
          } else {
            pendingRoom.removeAllListeners();
            void pendingRoom.disconnect(true).catch(() => undefined);
          }
        }
        if (joinAbortRef.current === controller) joinAbortRef.current = null;
        if (attempt === joinAttemptRef.current) {
          joiningRef.current = false;
          setJoining(false);
        }
        settleInflight();
        if (startMediaInflightRef.current === thisInflight) {
          startMediaInflightRef.current = null;
        }
      }
    },
    [
      addRemoteTrack,
      applyNoiseFilterToRoom,
      callBusy,
      cleanupRoom,
      emitMediaState,
      managedPresence,
      resetState,
      selfId,
      socket,
      stopMedia,
      syncLocalStream,
      token,
      wireRoom,
    ],
  );

  startMediaRef.current = startMedia;

  useEffect(() => {
    peersSnapshotRef.current = peers;
  }, [peers]);

  const join = useCallback(
    async (channelId: string, groupId: string, title: string) => {
      if (!socket || !selfId || !token) return;
      if (callBusy) {
        setError("Сначала завершите звонок");
        return;
      }
      if (activeRef.current?.channelId === channelId) return;
      const result = await new Promise<{
        ok?: boolean;
        peers?: VoiceChannelUser[];
        error?: string;
      }>((resolve) => {
        socket.emit("voice:join", { channelId }, resolve);
      });
      if (!result.ok) {
        setError(result.error || "Не удалось войти");
        return;
      }
      try {
        await startMedia(channelId, groupId, title, result.peers || []);
      } catch {
        socket.emit("voice:leave");
      }
    },
    [callBusy, selfId, socket, startMedia, token],
  );

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room || audioBusyRef.current) return;
    const next = !mutedRef.current;
    audioBusyRef.current = true;
    try {
      await room.localParticipant.setMicrophoneEnabled(
        !next,
        liveKitAudioCapture(),
      );
      if (roomRef.current !== room) {
        audioBusyRef.current = false;
        return;
      }
      if (!next) await applyNoiseFilterToRoom(room);
      mutedRef.current = next;
      setMuted(next);
      syncLocalStream(room);
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
    } catch {
      if (roomRef.current !== room) {
        audioBusyRef.current = false;
        return;
      }
      setError("Не удалось изменить микрофон");
    } finally {
      audioBusyRef.current = false;
    }
  }, [applyNoiseFilterToRoom, socket, syncLocalStream]);

  const toggleDeafen = useCallback(async () => {
    const room = roomRef.current;
    if (!room || audioBusyRef.current) return;
    const next = !deafenedRef.current;
    audioBusyRef.current = true;
    try {
      if (next && !mutedRef.current) {
        await room.localParticipant.setMicrophoneEnabled(false);
        if (roomRef.current !== room) {
          audioBusyRef.current = false;
          return;
        }
        mutedRef.current = true;
        setMuted(true);
        syncLocalStream(room);
        socket?.emit("voice:mute", { muted: true });
      } else if (!next && mutedRef.current) {
        await room.localParticipant.setMicrophoneEnabled(
          true,
          liveKitAudioCapture(),
        );
        if (roomRef.current !== room) {
          audioBusyRef.current = false;
          return;
        }
        await applyNoiseFilterToRoom(room);
        mutedRef.current = false;
        setMuted(false);
        syncLocalStream(room);
        socket?.emit("voice:mute", { muted: false });
      }
    } catch {
      if (roomRef.current !== room) {
        audioBusyRef.current = false;
        return;
      }
      setError("Не удалось отключить микрофон");
      audioBusyRef.current = false;
      return;
    }
    deafenedRef.current = next;
    setDeafened(next);
    for (const audio of remoteAudioRef.current.values()) {
      audio.muted = next;
      if (!next) void audio.play().catch(() => undefined);
    }
    socket?.emit("voice:deafen", { deafened: next });
    audioBusyRef.current = false;
  }, [applyNoiseFilterToRoom, socket, syncLocalStream]);

  const toggleNoiseFilter = useCallback(() => {
    setKrispEnabled(!getKrispEnabled());
  }, []);

  const applyVoiceSettings = useCallback(
    async (change: VoiceSettingsChange) => {
      const room = roomRef.current;
      setNoiseFilterEnabled(getKrispEnabled());
      if (change.speaker) {
        const speakerId = getSpeakerDeviceId() || "default";
        if (room) {
          await room
            .switchActiveDevice("audiooutput", speakerId)
            .catch(() => undefined);
        }
        await Promise.all(
          [...remoteAudioRef.current.values()].map((audio) =>
            applyAudioOutput(audio),
          ),
        );
      }
      if (!change.mic && !change.noise) return;
      if (!room) return;
      try {
        if (change.mic) {
          const micId = getMicDeviceId() || "default";
          await room.switchActiveDevice("audioinput", micId).catch(() => undefined);
        }
        if (!mutedRef.current) {
          await applyNoiseFilterToRoom(room);
          syncLocalStream(room);
        }
      } catch {
        /* keep previous devices if switch fails */
      }
    },
    [applyNoiseFilterToRoom, syncLocalStream],
  );

  useEffect(() => subscribeVoiceSettings((change) => {
    void applyVoiceSettings(change);
  }), [applyVoiceSettings]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room || mediaBusyRef.current) return;
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      const turningOn = cameraOffRef.current;
      await room.localParticipant.setCameraEnabled(
        turningOn,
        CAMERA_CAPTURE,
        { simulcast: true },
      );
      if (roomRef.current !== room) {
        void room.disconnect(true).catch(() => undefined);
        return;
      }
      cameraOffRef.current = !turningOn;
      setCameraOff(!turningOn);
      emitMediaState(!turningOn, sharingScreenRef.current);
      syncLocalStream(room);
    } catch {
      if (roomRef.current !== room) return;
      setError("Камера недоступна");
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  }, [emitMediaState, syncLocalStream]);

  const stopScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (
      !room ||
      !sharingScreenRef.current ||
      screenStopBusyRef.current
    ) {
      return;
    }
    screenStopBusyRef.current = true;
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } catch {
      if (roomRef.current !== room) {
        screenStopBusyRef.current = false;
        return;
      }
      const screenTrack = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShare,
      )?.track?.mediaStreamTrack;
      if (screenTrack?.readyState === "live") {
        setError("Не удалось остановить демонстрацию экрана");
        screenStopBusyRef.current = false;
        return;
      }
    }
    if (roomRef.current !== room) {
      screenStopBusyRef.current = false;
      void room.disconnect(true).catch(() => undefined);
      return;
    }
    sharingScreenRef.current = false;
    setSharingScreen(false);
    emitMediaState(cameraOffRef.current, false);
    syncLocalStream(room);
    screenStopBusyRef.current = false;
  }, [emitMediaState, syncLocalStream]);

  useEffect(() => {
    stopScreenShareRef.current = stopScreenShare;
  }, [stopScreenShare]);

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room || mediaBusyRef.current) return;
    mediaBusyRef.current = true;
    setMediaBusy(true);
    try {
      if (sharingScreenRef.current) {
        await stopScreenShare();
        return;
      }
      await enableLiveKitScreenShare(room);
      if (roomRef.current !== room) {
        void room.disconnect(true).catch(() => undefined);
        return;
      }
      sharingScreenRef.current = true;
      setSharingScreen(true);
      const publication = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShare,
      );
      const screenTrack = publication?.track?.mediaStreamTrack;
      if (screenTrack) {
        screenTrack.onended = () => {
          void stopScreenShareRef.current();
        };
      }
      emitMediaState(cameraOffRef.current, true);
      syncLocalStream(room);
    } catch {
      if (roomRef.current !== room) {
        void room.disconnect(true).catch(() => undefined);
        return;
      }
      setError("Демонстрация экрана недоступна");
      sharingScreenRef.current = false;
      setSharingScreen(false);
      emitMediaState(cameraOffRef.current, false);
      syncLocalStream(room);
    } finally {
      mediaBusyRef.current = false;
      setMediaBusy(false);
    }
  }, [emitMediaState, stopScreenShare, syncLocalStream]);

  useEffect(() => {
    if (!socket) return;

    const rejoinAfterReconnect = (retry = 0) => {
      if (managedPresence) return;
      const current = activeRef.current;
      if (!current || !socket.connected) return;
      socket.emit(
        "voice:join",
        { channelId: current.channelId },
        (result: {
          ok?: boolean;
          peers?: VoiceChannelUser[];
          error?: string;
        }) => {
          if (activeRef.current?.channelId !== current.channelId) return;
          if (!result.ok) {
            if (
              result.error === "Сначала войдите в аккаунт" &&
              retry < 16
            ) {
              reconnectTimerRef.current = window.setTimeout(
                () => rejoinAfterReconnect(retry + 1),
                500,
              );
              return;
            }
            cleanupRoom();
            resetState();
            setError(result.error || "Не удалось восстановить голосовой канал");
            return;
          }
          setPeers(result.peers || []);
          socket.emit("voice:mute", { muted: mutedRef.current });
          socket.emit("voice:deafen", { deafened: deafenedRef.current });
          emitMediaState(cameraOffRef.current, sharingScreenRef.current);
        },
      );
    };

    const onConnect = () => {
      if (managedPresence || !activeRef.current) return;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = window.setTimeout(
        () => rejoinAfterReconnect(),
        100,
      );
    };

    const onState = (payload: {
      channels?: { id: string; users: VoiceChannelUser[] }[];
    }) => {
      const current = activeRef.current;
      if (!current || !payload.channels) return;
      const channel = payload.channels.find((item) => item.id === current.channelId);
      if (!channel) {
        if (!managedPresence) {
          cleanupRoom();
          resetState();
        }
        return;
      }
      setPeers(channel.users.filter((user) => user.userId !== selfId));
    };

    const onMedia = (payload: {
      channelId?: string;
      userId?: string;
      cameraOff?: boolean;
      sharingScreen?: boolean;
    }) => {
      if (
        payload.channelId !== activeRef.current?.channelId ||
        !payload.userId ||
        payload.userId === selfId
      ) {
        return;
      }
      setPeers((current) =>
        current.map((peer) =>
          peer.userId === payload.userId
            ? {
                ...peer,
                cameraOff: payload.cameraOff ?? peer.cameraOff,
                sharingScreen:
                  payload.sharingScreen ?? peer.sharingScreen,
              }
            : peer,
        ),
      );
    };

    const onKick = (payload: { channelId?: string; reason?: string }) => {
      if (payload.channelId !== activeRef.current?.channelId) return;
      cleanupRoom();
      resetState();
      if (payload.reason === "takeover") {
        setError("Вы подключились к каналу с другой вкладки");
      }
    };

    socket.on("voice:state", onState);
    socket.on("voice:media", onMedia);
    socket.on("voice:kick", onKick);
    socket.on("connect", onConnect);
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socket.off("voice:state", onState);
      socket.off("voice:media", onMedia);
      socket.off("voice:kick", onKick);
      socket.off("connect", onConnect);
    };
  }, [cleanupRoom, emitMediaState, managedPresence, resetState, selfId, socket]);

  useEffect(() => {
    if (!active) return;
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      const room = roomRef.current;
      void room
        ?.startAudio()
        .then(() => {
          if (room.canPlaybackAudio) {
            setError((current) =>
              current === "Нажмите в окно, чтобы включить звук"
                ? null
                : current,
            );
          }
        })
        .catch(() => undefined);
      for (const audio of remoteAudioRef.current.values()) {
        audio.muted = deafenedRef.current;
        if (!deafenedRef.current) void audio.play().catch(() => undefined);
      }
    };
    const onVisibility = () => {
      applyRemoteVideoQuality();
      resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", resume);
    window.addEventListener("pointerdown", resume, { capture: true });
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", resume);
      window.removeEventListener("pointerdown", resume, { capture: true });
    };
  }, [active, applyRemoteVideoQuality]);

  useEffect(() => {
    if (!active || !socket) return;
    const AudioCtx =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    let ctx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let hookedTrackId = "";
    const samples = createSpeakingSamples();

    const setSpeaking = (next: boolean) => {
      if (speakingRef.current === next) return;
      speakingRef.current = next;
      setSelfSpeaking(next);
      socket.emit("voice:speaking", { speaking: next });
    };

    const stopTicker = startSpeakingTicker(() => {
      if (mutedRef.current) {
        speakHoldUntilRef.current = 0;
        setSpeaking(false);
        return;
      }
      const publication = roomRef.current?.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      );
      const lkTrack = publication?.track;
      const mic = pickSpeakingTrack(
        noiseFilterRef.current?.sourceTrack ||
          (lkTrack instanceof LocalAudioTrack
            ? lkTrack.mediaStreamTrack
            : null),
      );
      if (!mic || mic.readyState !== "live" || mic.enabled === false) {
        setSpeaking(false);
        return;
      }
      try {
        if (!ctx) ctx = new AudioCtx();
        if (ctx.state === "suspended") void ctx.resume();
        if (hookedTrackId !== mic.id || !analyser || !source) {
          try {
            source?.disconnect();
          } catch {
            /* ignore */
          }
          source = ctx.createMediaStreamSource(new MediaStream([mic]));
          analyser = ctx.createAnalyser();
          configureSpeakingAnalyser(analyser);
          source.connect(analyser);
          hookedTrackId = mic.id;
        }
        const level = speakingLevelFromAnalyser(analyser, samples);
        const now = Date.now();
        if (level > SPEAKING_THRESHOLD) {
          speakHoldUntilRef.current = now + SPEAKING_HOLD_MS;
        }
        setSpeaking(now < speakHoldUntilRef.current);
      } catch {
        /* analyser soft-fail */
      }
    });

    return () => {
      stopTicker();
      try {
        source?.disconnect();
      } catch {
        /* ignore */
      }
      void ctx?.close();
      speakHoldUntilRef.current = 0;
      if (speakingRef.current) {
        speakingRef.current = false;
        setSelfSpeaking(false);
        socket.emit("voice:speaking", { speaking: false });
      }
    };
  }, [active, socket]);

  useEffect(() => {
    minimizedRef.current = minimized;
    applyRemoteVideoQuality();
  }, [applyRemoteVideoQuality, minimized]);

  useEffect(() => {
    const previousToken = sessionTokenRef.current;
    sessionTokenRef.current = token;
    if (
      previousToken &&
      previousToken !== token &&
      (activeRef.current || joiningRef.current)
    ) {
      leave();
    }
  }, [leave, token]);

  useEffect(
    () => () => {
      joinAttemptRef.current += 1;
      joinAbortRef.current?.abort();
      joinAbortRef.current = null;
      if (
        !managedPresence &&
        (activeRef.current || joiningRef.current)
      ) {
        socket?.emit("voice:leave");
      }
      intentionalDisconnectRef.current = true;
      cleanupRoom();
    },
    [cleanupRoom, managedPresence, socket],
  );

  const clearError = useCallback(() => setError(null), []);
  const setPeersExternal = useCallback((next: VoiceChannelUser[]) => {
    setPeers(next);
  }, []);
  const hasRoom = useCallback(() => Boolean(roomRef.current), []);

  return {
    active,
    peers,
    selfName,
    localStream,
    remoteStreams,
    muted,
    deafened,
    cameraOff,
    sharingScreen,
    mediaBusy,
    minimized,
    joining,
    error,
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
    setMinimized,
    clearError,
    selfSpeaking,
    noiseFilterEnabled,
    noiseFilterKind,
    hasRoom,
  };
}
