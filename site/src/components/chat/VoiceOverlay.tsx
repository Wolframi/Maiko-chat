"use client";

import {
  Fragment,
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
  IconSwitchCamera,
  IconHeadphones,
  IconMic,
  IconMicOff,
  IconMinimize,
  IconPhoneOff,
  IconScreen,
  IconNoise,
} from "@/lib/icons";
import { ConnectionSignal, type SignalQuality } from "@/components/chat/ConnectionSignal";
import { CameraControl } from "@/components/chat/CameraControl";
import { Avatar } from "@/components/chat/Avatar";
import { MediaVideo } from "@/components/chat/MediaVideo";
import { ScreenAudioVisualizer } from "@/components/chat/ScreenAudioVisualizer";
import {
  ScreenShareKeepalive,
  ScreenShareStage,
  ScreenInlineVolume,
  type ScreenSource,
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
import { useCallTileInteraction } from "@/hooks/useCallTileInteraction";
import { useCallTileLayout } from "@/hooks/useCallTileLayout";

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
  connectionLabel?: string | null;
  connectionQuality?: SignalQuality;
  rttMs?: number | null;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleNoiseFilter?: () => void;
  onToggleCamera: () => void;
  onSelectCamera?: (deviceId: string) => void;
  cameraDeviceId?: string;
  onFlipCamera?: () => void;
  canFlipCamera?: boolean;
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
  const list: ScreenSource[] = [];
  if (sharingScreen && localScreenStream) {
    list.push({
      id: "self",
      label: "Ваш экран",
      stream: localScreenStream,
      audioStream: localStream,
      kind: "screen",
      ownerId: "self",
      local: true,
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
      audioStream: stream,
      kind: "screen",
      ownerId: peer.userId,
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
  const picked = useMemo(() => {
    if (!stream) return null;
    return kind === "camera"
      ? pickCameraStream(stream)
      : pickScreenStream(stream);
    // signature captures track identity/state changes for the same MediaStream object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, signature, kind]);
  const heldRef = useRef<MediaStream | null>(null);
  const pickedLive = picked?.getVideoTracks().some((track) => track.readyState === "live");
  if (picked && pickedLive) heldRef.current = picked;
  else if (!heldRef.current?.getVideoTracks().some((track) => track.readyState === "live")) {
    heldRef.current = null;
  }
  return (pickedLive ? picked : null) ?? heldRef.current;
}

function participantGridClass(count: number) {
  if (count <= 1) return "call__tiles--c1";
  if (count <= 4) return "call__tiles--c2";
  if (count <= 6) return "call__tiles--c3";
  return "call__tiles--c4";
}

type TileProps = {
  name: string;
  subtitle?: string;
  avatarUrl?: string;
  stream: MediaStream | null;
  showVideo: boolean;
  speaking?: boolean;
  muted?: boolean;
  self?: boolean;
  source?: ScreenSource;
  onSwap?: (fromId: string, toId: string) => void;
};

function VoiceTile({
  name,
  subtitle,
  avatarUrl,
  stream,
  showVideo,
  speaking = false,
  muted: tileMuted = false,
  self = false,
  source,
  onSwap,
}: TileProps) {
  const interaction = useCallTileInteraction({
    id: source?.id ?? name,
    onSwap: source ? onSwap : undefined,
    open: showVideo,
  });
  return (
    <div
      className={`call__tile ${speaking ? "is-speaking" : ""} ${
        showVideo ? "has-video" : ""
      } ${source?.kind === "screen" ? "has-screen" : ""
      } ${self ? "call__tile--self" : ""} ${
        showVideo ? "is-interactive" : ""
      }`}
      role={showVideo ? "button" : undefined}
      tabIndex={showVideo ? 0 : undefined}
      aria-label={showVideo ? `Открыть ${name}` : undefined}
      title={showVideo ? (onSwap ? "Нажатие — на весь экран; перетаскивание или Alt + стрелка — поменять местами" : "Нажатие — на весь экран") : undefined}
      {...interaction}
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
        {subtitle ? (
          <span className="call__tile-label">
            <strong>{name}</strong>
            <small>{subtitle}</small>
          </span>
        ) : (
          <span>{name}</span>
        )}
        {tileMuted ? <IconMicOff size={14} className="call__tile-icon" /> : null}
      </em>
      {source?.kind === "screen" ? (
        <ScreenAudioVisualizer stream={source.audioStream ?? source.stream} />
      ) : null}
      {source?.kind === "screen" && !source.local ? (
        <footer
          className="call__screen-controls"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ScreenInlineVolume owner={source.ownerId ?? source.id} label={source.label} />
        </footer>
      ) : null}
    </div>
  );
}

function PeerCameraTile({
  peer,
  stream,
  subtitle,
  hideMuted = false,
}: {
  peer: VoiceChannelUser;
  stream: MediaStream | null | undefined;
  subtitle?: string;
  hideMuted?: boolean;
}) {
  const cameraStream = useStablePickedStream(stream, "camera");
  const showVideo = peerShowsCamera(peer, stream);
  return (
    <VoiceTile
      name={peer.name}
      subtitle={subtitle}
      avatarUrl={peer.avatarUrl}
      stream={cameraStream}
      showVideo={showVideo}
      speaking={peer.speaking}
      muted={hideMuted ? false : peer.muted}
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
  connectionLabel = null,
  connectionQuality = "unknown",
  rttMs = null,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onToggleNoiseFilter,
  onToggleCamera,
  onSelectCamera,
  cameraDeviceId,
  onFlipCamera,
  canFlipCamera = false,
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
  const cameraSources = useMemo(() => {
    const sources = new Map<string, ScreenSource>();
    if (localCamera && localCameraStream) {
      sources.set("self", {
        id: "camera:self",
        ownerId: "self",
        kind: "camera",
        label: `Камера · ${selfName}`,
        stream: localCameraStream,
        local: true,
      });
    }
    for (const peer of peers) {
      const stream = remoteStreams[peer.userId];
      if (!peerShowsCamera(peer, stream)) continue;
      const camera = pickCameraStream(stream);
      if (!camera) continue;
      sources.set(peer.userId, {
        id: `camera:${peer.userId}`,
        ownerId: peer.userId,
        kind: "camera",
        label: `Камера · ${peer.name}`,
        stream: camera,
      });
    }
    return sources;
  }, [localCamera, localCameraStream, peers, remoteStreams, selfName]);
  const mediaSources = [...screenSources, ...cameraSources.values()];
  const { ordered: arrangedSources, swap: swapMediaTiles } = useCallTileLayout(mediaSources);
  const stageSources = arrangedSources.slice(0, screenCount);
  const railSources = new Map(
    [...cameraSources.keys()].map((ownerId, index) => [
      ownerId, arrangedSources[screenCount + index],
    ]),
  );
  const screenMode = screenCount > 0;

  const renderMediaTile = (source: ScreenSource) => {
    const owner = peers.find((peer) => peer.userId === source.ownerId);
    const isCamera = source.kind === "camera";
    return (
      <VoiceTile
        name={isCamera ? (source.local ? selfName : owner?.name ?? source.label) : source.label}
        stream={source.stream}
        source={source}
        showVideo
        speaking={isCamera && (source.local ? selfSpeaking : owner?.speaking)}
        muted={isCamera && (source.local ? muted : owner?.muted)}
        self={source.local}
        onSwap={swapMediaTiles}
      />
    );
  };

  useEffect(() => {
    const timer = window.setTimeout(() => endRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [active?.channelId]);

  const cardMode = screenMode
    ? "call__card--screen"
    : localCamera || peers.some((p) => peerShowsCamera(p, remoteStreams[p.userId]))
      ? "call__card--camera"
      : "call__card--voice";
  const cardSize =
    screenMode && stageSources.length > 1 ? "call__card--dual-screen" : "";
  const sittingAlone = !screenMode && peers.length === 0;
  const duoParticipants = !screenMode && peers.length === 1;
  const participantCount = peers.length + 1;

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
        <div className="call__qos"><ConnectionSignal quality={connectionQuality} rttMs={rttMs} pending={connectionLabel} /></div>
        {connectionLabel ? (
          <p className="call__link" role="status">
            {connectionLabel}
          </p>
        ) : null}
        {screenMode ? (
          <div className="call__stage-body">
            <section className="call__main-area">
              <ScreenShareStage sources={stageSources} onSwap={swapMediaTiles} />
            </section>

            <aside
              className="call__participants-rail"
              aria-label="Участники звонка"
            >
              {peers.map((peer) => {
                const ownerId = peer.userId;
                const source = railSources.get(ownerId);
                if (source) return <Fragment key={ownerId}>{renderMediaTile(source)}</Fragment>;

                return (
                  <PeerCameraTile
                    key={ownerId}
                    peer={peer}
                    stream={remoteStreams[ownerId]}
                  />
                );
              })}
              {railSources.has("self") ? (
                renderMediaTile(railSources.get("self")!)
              ) : (
                <VoiceTile
                  name={selfName}
                  avatarUrl={selfAvatarUrl ?? undefined}
                  stream={localCameraStream}
                  showVideo={localCamera}
                  speaking={selfSpeaking}
                  muted={muted}
                  self
                />
              )}
            </aside>
          </div>
        ) : (
          <div
            className={`call__tiles ${
              sittingAlone
                ? "call__tiles--solo"
                : duoParticipants
                  ? "call__tiles--duo"
                  : `call__tiles--grid ${participantGridClass(
                      participantCount,
                    )} call__tiles--count-${Math.min(participantCount, 12)}`
            }`}
            data-participant-count={participantCount}
          >
            {peers.map((peer) => (
              <PeerCameraTile
                key={peer.userId}
                peer={peer}
                stream={remoteStreams[peer.userId]}
                subtitle={
                  cardMode === "call__card--voice" && !duoParticipants
                    ? peer.muted
                      ? "Микрофон выключен"
                      : peer.speaking
                        ? "Говорит"
                        : "В голосовом канале"
                    : undefined
                }
                hideMuted={duoParticipants}
              />
            ))}
            <VoiceTile
              name={duoParticipants ? "Вы" : selfName}
              subtitle={
                cardMode === "call__card--voice" && !duoParticipants
                  ? muted
                    ? "Микрофон выключен"
                    : sittingAlone
                      ? undefined
                      : "Это вы"
                  : undefined
              }
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
          <span className={connectionLabel ? "is-pending" : ""}>
            {connectionLabel || "в канале"}
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
          <CameraControl
            cameraOff={cameraOff}
            mediaBusy={mediaBusy}
            cameraDeviceId={cameraDeviceId}
            localStream={localStream}
            onToggleCamera={onToggleCamera}
            onSelectCamera={onSelectCamera}
          />
          {canFlipCamera && !cameraOff && onFlipCamera ? (
            <button
              type="button"
              className="call__btn call__btn--circle"
              onClick={onFlipCamera}
              disabled={mediaBusy}
              aria-label="Переключить камеру"
              title="Переключить камеру"
            >
              <IconSwitchCamera size={20} />
            </button>
          ) : null}
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
      const next = document.getElementById("pulse-call-dock");
      setSlot((current) => {
        if (next) return next === current ? current : next;
        return current?.isConnected ? current : null;
      });
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
  connectionLabel = null,
  connectionQuality = "unknown",
  rttMs = null,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onToggleNoiseFilter,
  onToggleCamera,
  onSelectCamera,
  cameraDeviceId,
  onFlipCamera,
  canFlipCamera = false,
  onToggleScreenShare,
  onToggleMinimized,
  onExpand,
}: VoiceOverlayProps) {
  const voiceInThisGroup = Boolean(
    active && currentGroupId && active.groupId === currentGroupId,
  );
  const showDock = Boolean(active && voiceInThisGroup && !minimized);
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

  return (
    <>
      {showDock ? null : <ScreenShareKeepalive sources={screenSources} />}
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
              connectionLabel={connectionLabel}
              connectionQuality={connectionQuality}
              rttMs={rttMs}
              onLeave={onLeave}
              onToggleMute={onToggleMute}
              onToggleDeafen={onToggleDeafen}
              onToggleNoiseFilter={onToggleNoiseFilter}
              onToggleCamera={onToggleCamera}
              onSelectCamera={onSelectCamera}
              cameraDeviceId={cameraDeviceId}
              onFlipCamera={onFlipCamera}
              canFlipCamera={canFlipCamera}
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
