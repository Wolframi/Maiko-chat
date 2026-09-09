"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { VoiceChannelUser } from "@/lib/types";
import {
  IconCamera,
  IconCameraOff,
  IconExpand,
  IconHeadphones,
  IconMic,
  IconMicOff,
  IconMinimize,
  IconPhoneOff,
  IconScreen,
  IconVolume,
  IconNoise,
} from "@/lib/icons";
import { Avatar } from "@/components/chat/Avatar";
import { MediaVideo } from "@/components/chat/MediaVideo";
import {
  ScreenShareKeepalive,
  ScreenShareStage,
} from "@/components/chat/ScreenShareStage";
import {
  pickCameraStream,
  pickScreenStream,
  streamHasCameraVideo,
  streamHasScreenVideo,
  streamLooksLikeScreen,
} from "@/lib/webrtcMedia";
import { noiseFilterLabel, type NoiseFilterKind } from "@/lib/noiseFilter";
import { softSpring, sheetSpring } from "@/lib/motion";

type VoiceOverlayProps = {
  active: {
    channelId: string;
    groupId: string;
    title: string;
  } | null;
  peers: VoiceChannelUser[];
  selfId?: string;
  selfName?: string;
  selfAvatarUrl?: string | null;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  muted: boolean;
  deafened: boolean;
  cameraOff: boolean;
  sharingScreen: boolean;
  mediaBusy?: boolean;
  minimized: boolean;
  currentGroupId?: string | null;
  selfSpeaking?: boolean;
  noiseFilterEnabled?: boolean;
  noiseFilterKind?: NoiseFilterKind;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleNoiseFilter?: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleMinimized: () => void;
  onExpand?: () => void;
};

function peerShowsCamera(
  peer: VoiceChannelUser,
  stream: MediaStream | null | undefined,
) {
  if (peer.cameraOff) return false;
  return streamHasCameraVideo(stream ?? null);
}

function peerShowsScreen(
  peer: VoiceChannelUser,
  stream: MediaStream | null | undefined,
  sharingFlag: boolean,
) {
  if (streamHasScreenVideo(stream ?? null)) return true;
  if (!sharingFlag || !stream) return false;
  // Fallback when contentHint/settings are missing: lone non-camera video while sharing.
  return (
    stream.getVideoTracks().some(
      (track) => track.readyState === "live" && track.enabled,
    ) && !streamHasCameraVideo(stream)
  );
}

function collectScreenSources(
  localStream: MediaStream | null,
  remoteStreams: Record<string, MediaStream>,
  peers: VoiceChannelUser[],
  sharingScreen: boolean,
) {
  const localScreenStream = pickScreenStream(localStream);
  const list: { id: string; label: string; stream: MediaStream }[] = [];
  if (sharingScreen && localScreenStream) {
    list.push({
      id: "self",
      label: "Ваш экран",
      stream: localScreenStream,
    });
  }
  for (const peer of peers) {
    const stream = remoteStreams[peer.userId];
    if (
      !stream ||
      !peerShowsScreen(peer, stream, peer.sharingScreen ?? false)
    ) {
      continue;
    }
    const screen = pickScreenStream(stream);
    if (!screen) continue;
    list.push({
      id: peer.userId,
      label: `Экран · ${peer.name}`,
      stream: screen,
    });
  }
  return list;
}

function useStablePickedStream(
  stream: MediaStream | null | undefined,
  kind: "camera" | "screen",
) {
  const signature =
    stream
      ?.getVideoTracks()
      .map(
        (track) =>
          `${track.id}:${track.readyState}:${track.enabled}:${track.contentHint}`,
      )
      .join("|") ?? "";
  return useMemo(() => {
    if (!stream) return null;
    return kind === "camera"
      ? pickCameraStream(stream)
      : pickScreenStream(stream);
    // signature captures track identity/state changes for the same MediaStream object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, signature, kind]);
}

type TileProps = {
  name: string;
  avatarUrl?: string;
  stream: MediaStream | null;
  showVideo: boolean;
  speaking?: boolean;
  muted?: boolean;
  self?: boolean;
};

function VoiceTile({
  name,
  avatarUrl,
  stream,
  showVideo,
  speaking = false,
  muted: tileMuted = false,
  self = false,
}: TileProps) {
  return (
    <div
      className={`call__tile ${showVideo && speaking ? "is-speaking" : ""} ${
        showVideo ? "has-video" : ""
      } ${self ? "call__tile--self" : ""}`}
    >
      <MediaVideo
        stream={stream}
        active={Boolean(stream)}
        className={`call__tile-video ${
          self && !streamLooksLikeScreen(stream) ? "is-camera" : ""
        } ${showVideo ? "" : "is-hidden"}`}
      />
      {!showVideo && (
        <div className={`call__tile-avatar ${speaking ? "is-speaking" : ""}`}>
          <Avatar name={name} src={avatarUrl} size="xl" />
        </div>
      )}
      <em className="call__tile-name">
        <span>{name}</span>
        {tileMuted ? <IconMicOff size={14} className="call__tile-icon" /> : null}
      </em>
    </div>
  );
}

function PeerCameraTile({
  peer,
  stream,
}: {
  peer: VoiceChannelUser;
  stream: MediaStream | null | undefined;
}) {
  const cameraStream = useStablePickedStream(stream, "camera");
  const showVideo = peerShowsCamera(peer, stream);
  return (
    <VoiceTile
      name={peer.name}
      avatarUrl={peer.avatarUrl}
      stream={cameraStream}
      showVideo={showVideo}
      speaking={peer.speaking}
      muted={peer.muted}
    />
  );
}

function VoiceStagePanel({
  active,
  peers,
  selfName = "Вы",
  selfAvatarUrl = null,
  localStream,
  remoteStreams,
  muted,
  deafened,
  cameraOff,
  sharingScreen,
  mediaBusy = false,
  selfSpeaking = false,
  noiseFilterEnabled = true,
  noiseFilterKind = "browser",
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onToggleNoiseFilter,
  onToggleCamera,
  onToggleScreenShare,
  onToggleMinimized,
  dock = false,
}: Omit<VoiceOverlayProps, "minimized" | "currentGroupId" | "onExpand" | "selfId"> & {
  dock?: boolean;
}) {
  const endRef = useRef<HTMLButtonElement>(null);
  const localCameraStream = useStablePickedStream(localStream, "camera");
  const localCamera = !cameraOff && Boolean(localCameraStream);

  const screenSources = useMemo(
    () =>
      collectScreenSources(
        localStream,
        remoteStreams,
        peers,
        sharingScreen,
      ),
    [localStream, peers, remoteStreams, sharingScreen],
  );
  const screenCount = screenSources.length;
  const screenMode = screenCount > 0;

  useEffect(() => {
    const timer = window.setTimeout(() => endRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [active?.channelId]);

  const cardMode = screenMode
    ? "call__card--screen"
    : localCamera || peers.some((p) => peerShowsCamera(p, remoteStreams[p.userId]))
      ? "call__card--camera"
      : "call__card--voice";
  const cardSize = screenCount > 1 ? "call__card--dual-screen" : "";
  const sittingAlone = cardMode === "call__card--voice" && peers.length === 0;
  const duoAvatars = cardMode === "call__card--voice" && peers.length === 1;

  return (
    <motion.div
      className={`call__card call__card--unified ${cardMode} ${cardSize} ${
        dock ? "call__card--dock" : ""
      }`}
      initial={dock ? { opacity: 0, y: -8 } : { opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={dock ? { opacity: 0, y: -6 } : { opacity: 0, scale: 0.98 }}
      transition={dock ? softSpring : sheetSpring}
      role="region"
      aria-label={`Голосовой канал ${active?.title}`}
    >
      <button
        type="button"
        className="call__minimize"
        aria-label="Свернуть"
        onClick={onToggleMinimized}
      >
        <IconMinimize size={16} />
      </button>

      <div
        className={`call__stage call__stage--discord ${
          screenMode ? "is-screen" : "is-tiles"
        }`}
      >
        {screenMode ? (
          <div className="call__stage-body">
            <section className="call__main-area">
              <ScreenShareStage sources={screenSources} />
            </section>

            <aside
              className="call__participants-rail"
              aria-label="Участники звонка"
            >
              {peers.map((peer) => (
                <PeerCameraTile
                  key={peer.userId}
                  peer={peer}
                  stream={remoteStreams[peer.userId]}
                />
              ))}
              <VoiceTile
                name={selfName}
                avatarUrl={selfAvatarUrl ?? undefined}
                stream={localCameraStream}
                showVideo={localCamera}
                speaking={selfSpeaking}
                muted={muted}
                self
              />
            </aside>
          </div>
        ) : (
          <div
            className={`call__tiles ${
              sittingAlone
                ? "call__tiles--solo"
                : duoAvatars
                  ? "call__tiles--duo"
                  : `call__tiles--grid call__tiles--c${Math.min(
                      peers.length + 1,
                      4,
                    )}`
            }`}
          >
            {peers.map((peer) => (
              <PeerCameraTile
                key={peer.userId}
                peer={peer}
                stream={remoteStreams[peer.userId]}
              />
            ))}
            <VoiceTile
              name={selfName}
              avatarUrl={selfAvatarUrl ?? undefined}
              stream={localCameraStream}
              showVideo={localCamera}
              speaking={selfSpeaking}
              muted={muted}
              self
            />
          </div>
        )}
      </div>

      <div className="call__bar">
        <p className="call__status">
          <strong>{active?.title}</strong>
          <span>
            {peers.length === 0
              ? "только вы"
              : `${peers.length + 1} участников`}
            {screenCount > 0
              ? ` · ${screenCount === 1 ? "демонстрация" : `${screenCount} демонстрации`}`
              : ""}
            {deafened ? " · без звука" : ""}
          </span>
        </p>
        <div className="call__actions call__actions--dock">
          <button
            type="button"
            className={`call__btn call__btn--circle ${muted ? "is-off" : ""}`}
            onClick={onToggleMute}
            aria-label={muted ? "Включить микрофон" : "Выключить микрофон"}
            title={muted ? "Микрофон выкл." : "Микрофон"}
          >
            {muted ? <IconMicOff size={20} /> : <IconMic size={20} />}
          </button>
          <button
            type="button"
            className={`call__btn call__btn--circle ${deafened ? "is-off" : ""}`}
            onClick={onToggleDeafen}
            aria-label={deafened ? "Включить звук" : "Отключить звук"}
            title={deafened ? "Без звука" : "Звук канала"}
          >
            <IconHeadphones size={20} />
          </button>
          {onToggleNoiseFilter ? (
            <button
              type="button"
              className={`call__btn call__btn--circle ${
                noiseFilterEnabled ? "is-on" : "is-off"
              }`}
              onClick={onToggleNoiseFilter}
              aria-label={noiseFilterLabel(noiseFilterKind, noiseFilterEnabled)}
              title={noiseFilterLabel(noiseFilterKind, noiseFilterEnabled)}
            >
              <IconNoise size={20} />
            </button>
          ) : null}
          <button
            type="button"
            className={`call__btn call__btn--circle ${cameraOff ? "is-off" : ""}`}
            onClick={onToggleCamera}
            disabled={mediaBusy}
            aria-label={cameraOff ? "Включить камеру" : "Выключить камеру"}
            title={cameraOff ? "Камера выкл." : "Камера"}
          >
            {cameraOff ? <IconCameraOff size={20} /> : <IconCamera size={20} />}
          </button>
          <button
            type="button"
            className={`call__btn call__btn--circle ${sharingScreen ? "is-on" : ""}`}
            onClick={onToggleScreenShare}
            disabled={mediaBusy}
            aria-label={
              sharingScreen
                ? "Остановить демонстрацию"
                : "Демонстрация экрана"
            }
            title={sharingScreen ? "Стоп экрана" : "Показать экран"}
          >
            <IconScreen size={20} />
          </button>
          <button
            ref={endRef}
            type="button"
            className="call__btn call__btn--circle call__btn--bad"
            onClick={onLeave}
            aria-label="Выйти из канала"
            title="Отключиться"
          >
            <IconPhoneOff size={20} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function DockPortal({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    function sync() {
      setSlot(document.getElementById("pulse-call-dock"));
    }
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  if (!slot) return null;
  return createPortal(children, slot);
}

export function VoiceOverlay({
  active,
  peers,
  selfName = "Вы",
  selfAvatarUrl = null,
  localStream,
  remoteStreams,
  muted,
  deafened,
  cameraOff,
  sharingScreen,
  mediaBusy = false,
  minimized,
  currentGroupId = null,
  selfSpeaking = false,
  noiseFilterEnabled = true,
  noiseFilterKind = "browser",
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onToggleNoiseFilter,
  onToggleCamera,
  onToggleScreenShare,
  onToggleMinimized,
  onExpand,
}: VoiceOverlayProps) {
  const voiceInThisGroup = Boolean(
    active && currentGroupId && active.groupId === currentGroupId,
  );
  const showDock = Boolean(active && voiceInThisGroup && !minimized);
  const showMini = Boolean(active && !voiceInThisGroup);
  const screenSources = useMemo(
    () =>
      collectScreenSources(
        localStream,
        remoteStreams,
        peers,
        sharingScreen,
      ),
    [localStream, peers, remoteStreams, sharingScreen],
  );
  const sawSessionRef = useRef(false);
  const sharingRef = useRef(false);

  useEffect(() => {
    if (!active) {
      sawSessionRef.current = false;
      sharingRef.current = false;
      return;
    }
    const sharing = sharingScreen || peers.some((peer) => peer.sharingScreen);
    if (!sawSessionRef.current) {
      sawSessionRef.current = true;
      sharingRef.current = sharing;
      return;
    }
    if (sharing && !sharingRef.current && minimized) {
      onExpand?.();
    }
    sharingRef.current = sharing;
  }, [active, minimized, onExpand, peers, sharingScreen]);

  useEffect(() => {
    if (!showDock) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onToggleMinimized();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showDock, onToggleMinimized]);

  const anyRemoteScreen = peers.some((p) => p.sharingScreen);
  const anyCamera =
    !cameraOff || peers.some((p) => !p.cameraOff);

  return (
    <>
      <ScreenShareKeepalive sources={screenSources} />
      <AnimatePresence>
        {showMini && active && (
          <motion.div
            className="call-mini"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={softSpring}
          >
            <button
              type="button"
              className="call-mini__main"
              onClick={() => onExpand?.()}
              aria-label={`Развернуть голосовой канал ${active.title}`}
            >
              <span className="call-mini__avatar">
                <IconVolume size={18} />
              </span>
              <span>
                <strong>{active.title}</strong>
                <em>
                  {peers.length === 0
                    ? "только вы"
                    : `${peers.length + 1} участников`}
                  {sharingScreen || anyRemoteScreen ? " · экран" : ""}
                  {anyCamera ? " · видео" : ""}
                </em>
              </span>
              <IconExpand size={16} />
            </button>
            <button
              type="button"
              className="call-mini__end"
              onClick={onLeave}
              aria-label="Выйти из канала"
              title="Отключиться"
            >
              <IconPhoneOff size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDock && active ? (
          <DockPortal>
            <VoiceStagePanel
              active={active}
              peers={peers}
              selfName={selfName}
              selfAvatarUrl={selfAvatarUrl}
              localStream={localStream}
              remoteStreams={remoteStreams}
              muted={muted}
              deafened={deafened}
              cameraOff={cameraOff}
              sharingScreen={sharingScreen}
              mediaBusy={mediaBusy}
              selfSpeaking={selfSpeaking}
              noiseFilterEnabled={noiseFilterEnabled}
              noiseFilterKind={noiseFilterKind}
              onLeave={onLeave}
              onToggleMute={onToggleMute}
              onToggleDeafen={onToggleDeafen}
              onToggleNoiseFilter={onToggleNoiseFilter}
              onToggleCamera={onToggleCamera}
              onToggleScreenShare={onToggleScreenShare}
              onToggleMinimized={onToggleMinimized}
              dock
            />
          </DockPortal>
        ) : null}
      </AnimatePresence>
    </>
  );
}
