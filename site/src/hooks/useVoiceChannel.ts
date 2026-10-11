"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { VoiceChannelUser } from "@/lib/types";
import { useVoiceChannelLiveKit } from "@/hooks/useVoiceChannelLiveKit";
import {
  clearMediaResume,
  peekMediaResume,
  registerMediaResumePersist,
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
  const joiningRef = useRef(false);
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
      opts?: Partial<MediaControls> & {
        preserveControls?: boolean;
        switching?: boolean;
      },
    ) => Promise<void>;
    prepareSwitch: () => Promise<void>;
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
  const {
    muted, deafened, cameraOff, hasRoom, linkPhase,
    joining: sfuJoining, setMinimized: sfuSetMinimized,
  } = sfu;

  const startSfu = useCallback(
    async (
      session: ActiveVoice,
      nextPeers: VoiceChannelUser[],
      opts?: Partial<MediaControls> & {
        preserveControls?: boolean;
        switching?: boolean;
      },
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
        if (activeRef.current !== session) return;
        setPeers(nextPeers);
        setError(null);
      } catch (err) {
        if (activeRef.current !== session) return;
        if (err instanceof Error && err.name === "AbortError") return;
        api.stopMedia();
        socket?.emit("voice:leave");
        activeRef.current = null;
        setActive(null);
        setPeers([]);
        clearMediaResume();
        const message =
          err instanceof Error && /device not found/i.test(err.message)
            ? "Микрофон не найден — подключите устройство"
            : err instanceof Error
              ? err.message
              : "Не удалось подключиться к каналу";
        setError(message);
      }
    },
    [socket],
  );

  const leave = useCallback(() => {
    joinAttemptRef.current += 1;
    joiningRef.current = false;
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
      if (activeRef.current?.channelId === channelId && linkPhase !== "failed") {
        setMinimized(false);
        sfuSetMinimized(false);
        return;
      }
      const previous = activeRef.current;
      // Read the saved controls before a pending join can persist defaults.
      const resume = peekMediaResume();
      const moving = Boolean(previous && previous.channelId !== channelId);
      const live = sfuApiRef.current;
      const carried = moving
        ? {
            muted: live?.muted ?? false,
            deafened: live?.deafened ?? false,
            cameraOff: live?.cameraOff ?? true,
            sharingScreen: live?.sharingScreen ?? false,
            preserveControls: true,
            switching: true,
          }
        : undefined;
      const attempt = ++joinAttemptRef.current;
      joiningRef.current = true;
      setJoining(true);
      setError(null);
      const pendingSession = { channelId, groupId, title };
      activeRef.current = pendingSession;
      setActive(pendingSession);
      setMinimized(false);
      sfuSetMinimized(false);
      if (moving) {
        setPeers([]);
        await sfuApiRef.current?.prepareSwitch();
      }
      if (attempt !== joinAttemptRef.current) return;
      const askJoin = (nextChannelId: string) =>
        new Promise<JoinAck>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            reject(new Error("Сервер не ответил на вход в канал"));
          }, 10_000);
          socket.emit("voice:join", { channelId: nextChannelId }, (response: JoinAck) => {
            window.clearTimeout(timeout);
            resolve(response || {});
          });
        });
      try {
        const result = await askJoin(channelId);
        if (attempt !== joinAttemptRef.current) return;
        if (!result.ok) {
          if (moving && previous) {
            activeRef.current = previous;
            setActive(previous);
            setError(result.error || "Не удалось войти в канал");
            const back = await askJoin(previous.channelId);
            if (attempt !== joinAttemptRef.current) return;
            if (back.ok) {
              await startSfu(previous, back.peers || [], carried);
            } else {
              sfuApiRef.current?.stopMedia();
              activeRef.current = null;
              setActive(null);
              setPeers([]);
              socket.emit("voice:leave");
              clearMediaResume();
            }
            return;
          }
          activeRef.current = null;
          setActive(null);
          clearMediaResume();
          setError(result.error || "Не удалось войти в канал");
          return;
        }

        const session = { channelId, groupId, title };
        activeRef.current = session;
        setActive(session);
        setMinimized(false);
        sfuSetMinimized(false);
        const controls = moving
          ? carried
          : resume?.kind === "voice" && resume.channelId === channelId
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
          clearMediaResume();
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
        if (attempt === joinAttemptRef.current) {
          joiningRef.current = false;
          setJoining(false);
        }
      }
    },
    [callBusy, leave, selfId, sfuSetMinimized, linkPhase, socket, startSfu, token],
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
        if (!joiningRef.current && !sfuApiRef.current?.joining) leave();
        return;
      }
      if (
        selfId && !channel.users.some((user) => user.userId === selfId) &&
        socket.connected && !joiningRef.current && !sfuApiRef.current?.joining
      ) {
        leave();
        return;
      }
      const nextPeers = channel.users.filter((user) => user.userId !== selfId);
      setPeers(nextPeers);
      const api = sfuApiRef.current;
      if (!api) return;
      api.setPeersExternal(nextPeers);
      if (nextPeers.length > 0 && !joiningRef.current && !api.hasRoom() && !api.joining) {
        void startSfu(current, nextPeers, { preserveControls: true });
      }
    };

    const onKick = (payload: { channelId?: string; reason?: string }) => {
      if (payload.channelId !== activeRef.current?.channelId) return;
      joinAttemptRef.current += 1;
      joiningRef.current = false;
      setJoining(false);
      sfuApiRef.current?.stopMedia();
      activeRef.current = null;
      setActive(null);
      setPeers([]);
      setMinimized(false);
      clearMediaResume();
      if (payload.reason === "takeover") {
        setError("Вы подключились к каналу с другой вкладки");
      }
    };

    let reconnectTimer: number | undefined;
    const rejoinAfterReconnect = (current: ActiveVoice, retry = 0) => {
      if (activeRef.current !== current || !socket.connected) return;
      reconnectTimer = window.setTimeout(() => {
        if (activeRef.current !== current) return;
        leave();
        setError("Сервер не ответил на восстановление голосового канала");
      }, 10_000);
      socket.emit(
        "voice:join",
        { channelId: current.channelId },
        (result: JoinAck) => {
          if (activeRef.current !== current) return;
          window.clearTimeout(reconnectTimer);
          if (!result.ok) {
            if (result.error === "Сначала войдите в аккаунт" && retry < 16) {
              reconnectTimer = window.setTimeout(() => rejoinAfterReconnect(current, retry + 1), 500);
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
          }).finally(() => {
            if (activeRef.current !== current) return;
            joiningRef.current = false;
            setJoining(false);
          });
        },
      );
    };

    const onConnect = () => {
      const current = activeRef.current;
      if (!current) return;
      joiningRef.current = true;
      setJoining(true);
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => rejoinAfterReconnect(current), 100);
    };

    socket.on("voice:state", onState);
    socket.on("voice:kick", onKick);
    socket.on("connect", onConnect);
    return () => {
      window.clearTimeout(reconnectTimer);
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
    if (sfu.linkPhase !== "failed" || !activeRef.current) return;
    const message = sfu.error || "Соединение с голосовым сервером потеряно";
    leave();
    setError(message);
  }, [leave, sfu.error, sfu.linkPhase]);

  useEffect(() => {
    setLiveMediaSession("voice", Boolean(active));
    return () => setLiveMediaSession("voice", false);
  }, [active]);

  useEffect(() => {
    if (!active || joining || sfuJoining || !hasRoom()) return;
    const persist = () =>
      saveMediaResume({
        kind: "voice",
        channelId: active.channelId,
        groupId: active.groupId,
        title: active.title,
        muted,
        deafened,
        cameraOff,
      });
    persist();
    const unbind = registerMediaResumePersist(persist);
    const timer = window.setInterval(persist, 15_000);
    return () => {
      unbind();
      window.clearInterval(timer);
    };
  }, [active, joining, sfuJoining, hasRoom, muted, deafened, cameraOff]);

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
    connectionQuality: sfu.connectionQuality,
    connectionLabel:
      sfu.linkPhase === "failed"
        ? "Связь потеряна — подключитесь к каналу снова"
        : sfu.linkPhase === "reconnecting"
        ? "Восстановление связи…"
        : sfu.linkPhase === "switching"
          ? "Переключение…"
          : joining || sfu.joining || sfu.linkPhase === "connecting"
            ? "Подключение…"
            : null,
    error: error || sfu.error,
    join,
    leave,
    toggleMute: sfu.toggleMute,
    toggleDeafen: sfu.toggleDeafen,
    toggleCamera: sfu.toggleCamera,
    flipCamera: sfu.flipCamera,
    canFlipCamera: sfu.canFlipCamera,
    toggleScreenShare: sfu.toggleScreenShare,
    toggleNoiseFilter: sfu.toggleNoiseFilter,
    setMinimized: setMinimizedBoth,
    clearError,
    selfSpeaking: sfu.selfSpeaking,
    noiseFilterEnabled: sfu.noiseFilterEnabled,
    noiseFilterKind: sfu.noiseFilterKind,
  };
}
