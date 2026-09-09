"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { VoiceChannelUser } from "@/lib/types";
import { useVoiceChannelLiveKit } from "@/hooks/useVoiceChannelLiveKit";
import {
  clearMediaResume,
  peekMediaResume,
  saveMediaResume,
  setLiveMediaSession,
} from "@/lib/mediaResume";

type UseVoiceChannelOptions = {
  socket: Socket | null;
  selfId?: string;
  selfName?: string;
  token?: string | null;
  callBusy?: boolean;
};

type ActiveVoice = {
  channelId: string;
  groupId: string;
  title: string;
};

type JoinAck = {
  ok?: boolean;
  peers?: VoiceChannelUser[];
  topology?: "p2p" | "sfu";
  topologyEpoch?: number;
  error?: string;
};

type MediaControls = {
  muted: boolean;
  deafened: boolean;
  cameraOff: boolean;
  sharingScreen: boolean;
};

/**
 * Group voice is always self-hosted LiveKit SFU (this VM), never LiveKit Cloud
 * and never P2P mesh. 1:1 calls stay in `useCall` (P2P).
 */
export function useVoiceChannel({
  socket,
  selfId,
  selfName,
  token = null,
  callBusy = false,
}: UseVoiceChannelOptions) {
  const [active, setActive] = useState<ActiveVoice | null>(null);
  const [peers, setPeers] = useState<VoiceChannelUser[]>([]);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

  const activeRef = useRef<ActiveVoice | null>(null);
  const joinAttemptRef = useRef(0);
  const sfuApiRef = useRef<{
    localStream: MediaStream | null;
    muted: boolean;
    deafened: boolean;
    cameraOff: boolean;
    sharingScreen: boolean;
    startMedia: (
      channelId: string,
      groupId: string,
      title: string,
      peers?: VoiceChannelUser[],
      opts?: Partial<MediaControls> & { preserveControls?: boolean },
    ) => Promise<void>;
    stopMedia: () => void;
    setPeersExternal: (peers: VoiceChannelUser[]) => void;
    clearError: () => void;
    joining: boolean;
    hasRoom: () => boolean;
  } | null>(null);

  const sfu = useVoiceChannelLiveKit({
    socket,
    selfId,
    selfName,
    token,
    callBusy,
    managedPresence: true,
  });
  sfuApiRef.current = sfu;

  const startSfu = useCallback(
    async (
      session: ActiveVoice,
      nextPeers: VoiceChannelUser[],
      opts?: Partial<MediaControls> & { preserveControls?: boolean },
    ) => {
      const api = sfuApiRef.current;
      if (!api) return;
      try {
        await api.startMedia(
          session.channelId,
          session.groupId,
          session.title,
          nextPeers,
          opts,
        );
        setPeers(nextPeers);
        setError(null);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        api.stopMedia();
        socket?.emit("voice:leave");
        activeRef.current = null;
        setActive(null);
        setPeers([]);
        setError(
          err instanceof Error
            ? err.message
            : "SFU недоступен — вышли из канала",
        );
      }
    },
    [socket],
  );

  const leave = useCallback(() => {
    joinAttemptRef.current += 1;
    sfuApiRef.current?.stopMedia();
    socket?.emit("voice:leave");
    activeRef.current = null;
    setActive(null);
    setPeers([]);
    setMinimized(false);
    setError(null);
    setJoining(false);
    clearMediaResume();
  }, [socket]);

  const join = useCallback(
    async (channelId: string, groupId: string, title: string) => {
      if (!socket || !selfId || !token) return;
      if (callBusy) {
        setError("Сначала завершите звонок");
        return;
      }
      if (activeRef.current?.channelId === channelId) {
        setMinimized(false);
        sfu.setMinimized(false);
        return;
      }
      const attempt = ++joinAttemptRef.current;
      setJoining(true);
      setError(null);
      if (activeRef.current) {
        // Stop previous LiveKit media only. Do NOT call leave(): it bumps
        // joinAttemptRef and emits voice:leave, which races this join and
        // can leave presence on the server without an SFU session.
        sfuApiRef.current?.stopMedia();
        activeRef.current = null;
        setActive(null);
        setPeers([]);
      }

      try {
        const result = await new Promise<JoinAck>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            reject(new Error("Сервер не ответил на вход в канал"));
          }, 10_000);
          socket.emit("voice:join", { channelId }, (response: JoinAck) => {
            window.clearTimeout(timeout);
            resolve(response || {});
          });
        });
        if (attempt !== joinAttemptRef.current) return;
        if (!result.ok) {
          setError(result.error || "Не удалось войти в канал");
          return;
        }

        const session = { channelId, groupId, title };
        activeRef.current = session;
        setActive(session);
        setMinimized(false);
        sfu.setMinimized(false);
        const resume = peekMediaResume();
        const controls =
          resume?.kind === "voice" && resume.channelId === channelId
            ? {
                muted: resume.muted,
                deafened: resume.deafened,
                cameraOff: resume.cameraOff,
                preserveControls: true,
              }
            : undefined;
        await startSfu(session, result.peers || [], controls);
        if (attempt !== joinAttemptRef.current) return;
        if (
          activeRef.current?.channelId === channelId &&
          !sfuApiRef.current?.hasRoom()
        ) {
          socket.emit("voice:leave");
          activeRef.current = null;
          setActive(null);
          setPeers([]);
          setError("Не удалось подключиться к SFU");
        }
      } catch (err) {
        if (attempt !== joinAttemptRef.current) return;
        socket.emit("voice:leave");
        leave();
        setError(
          err instanceof Error ? err.message : "Не удалось войти в канал",
        );
      } finally {
        if (attempt === joinAttemptRef.current) setJoining(false);
      }
    },
    [callBusy, leave, selfId, sfu.setMinimized, socket, startSfu, token],
  );

  useEffect(() => {
    if (!socket) return;

    const onState = (payload: {
      groupId?: string;
      channels?: {
        id: string;
        title: string;
        users: VoiceChannelUser[];
        topology?: "p2p" | "sfu";
        topologyEpoch?: number;
      }[];
    }) => {
      const current = activeRef.current;
      if (!current || !payload.channels) return;
      if (payload.groupId && payload.groupId !== current.groupId) return;
      const channel = payload.channels.find(
        (item) => item.id === current.channelId,
      );
      if (!channel) {
        if (!sfuApiRef.current?.joining) leave();
        return;
      }
      const nextPeers = channel.users.filter((user) => user.userId !== selfId);
      setPeers(nextPeers);
      const api = sfuApiRef.current;
      if (!api) return;
      api.setPeersExternal(nextPeers);
      if (nextPeers.length > 0 && !api.hasRoom() && !api.joining) {
        void startSfu(current, nextPeers, { preserveControls: true });
      }
    };

    const onKick = (payload: { channelId?: string; reason?: string }) => {
      if (payload.channelId !== activeRef.current?.channelId) return;
      sfuApiRef.current?.stopMedia();
      activeRef.current = null;
      setActive(null);
      setPeers([]);
      if (payload.reason === "takeover") {
        setError("Вы подключились к каналу с другой вкладки");
      }
    };

    const rejoinAfterReconnect = (retry = 0) => {
      const current = activeRef.current;
      if (!current || !socket.connected) return;
      socket.emit(
        "voice:join",
        { channelId: current.channelId },
        (result: JoinAck) => {
          if (activeRef.current?.channelId !== current.channelId) return;
          if (!result.ok) {
            if (result.error === "Сначала войдите в аккаунт" && retry < 16) {
              window.setTimeout(() => rejoinAfterReconnect(retry + 1), 500);
              return;
            }
            leave();
            setError(
              result.error || "Не удалось восстановить голосовой канал",
            );
            return;
          }
          void startSfu(current, result.peers || [], {
            preserveControls: true,
          });
        },
      );
    };

    const onConnect = () => {
      if (!activeRef.current) return;
      window.setTimeout(() => rejoinAfterReconnect(), 100);
    };

    socket.on("voice:state", onState);
    socket.on("voice:kick", onKick);
    socket.on("connect", onConnect);
    return () => {
      socket.off("voice:state", onState);
      socket.off("voice:kick", onKick);
      socket.off("connect", onConnect);
    };
  }, [leave, selfId, socket, startSfu]);

  useEffect(() => {
    if (!token && activeRef.current) leave();
  }, [leave, token]);

  useEffect(() => {
    if (callBusy && activeRef.current) leave();
  }, [callBusy, leave]);

  useEffect(() => {
    setLiveMediaSession("voice", Boolean(active));
    if (!active) return;
    const persist = () =>
      saveMediaResume({
        kind: "voice",
        channelId: active.channelId,
        groupId: active.groupId,
        title: active.title,
        muted: sfu.muted,
        deafened: sfu.deafened,
        cameraOff: sfu.cameraOff,
      });
    persist();
    const timer = window.setInterval(persist, 15_000);
    return () => {
      window.clearInterval(timer);
      setLiveMediaSession("voice", false);
    };
  }, [active, sfu.muted, sfu.deafened, sfu.cameraOff]);

  useEffect(
    () => () => {
      joinAttemptRef.current += 1;
      sfuApiRef.current?.stopMedia();
    },
    [socket],
  );

  const clearError = useCallback(() => {
    setError(null);
    sfu.clearError();
  }, [sfu]);

  const sfuSetMinimized = sfu.setMinimized;
  const setMinimizedBoth = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      setMinimized((current) => {
        const value = typeof next === "function" ? next(current) : next;
        sfuSetMinimized(value);
        return value;
      });
    },
    [sfuSetMinimized],
  );

  return {
    active,
    peers: sfu.peers.length ? sfu.peers : peers,
    selfName,
    localStream: sfu.localStream,
    remoteStreams: sfu.remoteStreams,
    muted: sfu.muted,
    deafened: sfu.deafened,
    cameraOff: sfu.cameraOff,
    sharingScreen: sfu.sharingScreen,
    mediaBusy: sfu.mediaBusy,
    minimized,
    joining: joining || sfu.joining,
    error: error || sfu.error,
    join,
    leave,
    toggleMute: sfu.toggleMute,
    toggleDeafen: sfu.toggleDeafen,
    toggleCamera: sfu.toggleCamera,
    toggleScreenShare: sfu.toggleScreenShare,
    toggleNoiseFilter: sfu.toggleNoiseFilter,
    setMinimized: setMinimizedBoth,
    clearError,
    selfSpeaking: sfu.selfSpeaking,
    noiseFilterEnabled: sfu.noiseFilterEnabled,
    noiseFilterKind: sfu.noiseFilterKind,
  };
}
