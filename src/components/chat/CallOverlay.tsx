"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { CallMode, IncomingCall } from "@/lib/types";
import {
  IconCamera,
  IconCameraOff,
  IconExpand,
  IconMic,
  IconMicOff,
  IconMinimize,
  IconPhone,
  IconPhoneOff,
  IconScreen,
  IconHeadphones,
  IconNoise,
} from "@/lib/icons";
import { Avatar } from "@/components/chat/Avatar";
import { MediaVideo } from "@/components/chat/MediaVideo";
import {
  ScreenShareKeepalive,
  ScreenShareStage,
} from "@/components/chat/ScreenShareStage";
import { getSoundEnabled } from "@/lib/notify";
import { applyAudioOutput } from "@/lib/mediaDevices";
import { startIncomingRingtone, startOutgoingRingtone } from "@/lib/ringtone";
import { easeOutSoft, softSpring, sheetSpring } from "@/lib/motion";
import {
  pickCameraStream,
  pickScreenStream,
} from "@/lib/webrtcMedia";
import { noiseFilterLabel, type NoiseFilterKind } from "@/lib/noiseFilter";

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

type ActiveCall = {
  peerId: string;
  peerName: string;
  mode: CallMode;
  chatId: string;
  outbound: boolean;
};

type CallMediaProps = {
  active: ActiveCall;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  deafened?: boolean;
  cameraOff: boolean;
  sharingScreen: boolean;
  mediaBusy?: boolean;
  remoteSharingScreen: boolean;
  remoteCameraOff: boolean;
  peerAvatarUrl?: string | null;
  selfAvatarUrl?: string | null;
  status: string;
  durationLabel: string;
  networkQuality?: { rttMs: number; level: "good" | "ok" | "poor" } | null;
  localSpeaking?: boolean;
  remoteSpeaking?: boolean;
  noiseFilterEnabled?: boolean;
  noiseFilterKind?: NoiseFilterKind;
  onEnd: () => void;
  onToggleMute: () => void;
  onToggleDeafen?: () => void;
  onToggleNoiseFilter?: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleMinimized: () => void;
  /** Open the call's chat when expanding from the floating bar */
  onExpand?: () => void;
  dock?: boolean;
};

type CallOverlayProps = {
  incoming: IncomingCall | null;
  active: ActiveCall | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  deafened?: boolean;
  cameraOff: boolean;
  sharingScreen: boolean;
  mediaBusy?: boolean;
  remoteSharingScreen: boolean;
  remoteCameraOff: boolean;
  peerAvatarUrl?: string | null;
  selfAvatarUrl?: string | null;
  incomingAvatarUrl?: string | null;
  minimized: boolean;
  status: string;
  durationLabel: string;
  networkQuality?: { rttMs: number; level: "good" | "ok" | "poor" } | null;
  localSpeaking?: boolean;
  remoteSpeaking?: boolean;
  remoteAudioRef: RefObject<HTMLAudioElement | null>;
  currentChatId?: string | null;
  onAccept: () => void;
  onReject: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
  onToggleDeafen?: () => void;
  onToggleNoiseFilter?: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleMinimized: () => void;
  onExpandCall?: () => void;
  noiseFilterEnabled?: boolean;
  noiseFilterKind?: NoiseFilterKind;
};

function useRingTone(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    if (!getSoundEnabled()) return;
    return startIncomingRingtone();
  }, [enabled]);
}

function useOutgoingRing(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    if (!getSoundEnabled()) return;
    return startOutgoingRingtone();
  }, [enabled]);
}

function isOutboundRinging(outbound: boolean, status: string) {
  return outbound && (status === "Звоним…" || status === "Звонок" || status === "");
}

export function CallPanel({
  active,
  localStream,
  remoteStream,
  muted,
  deafened = false,
  cameraOff,
  sharingScreen,
  mediaBusy = false,
  remoteSharingScreen,
  remoteCameraOff,
  peerAvatarUrl = null,
  selfAvatarUrl = null,
  status,
  durationLabel,
  networkQuality = null,
  localSpeaking = false,
  remoteSpeaking = false,
  noiseFilterEnabled = true,
  noiseFilterKind = "browser",
  onEnd,
  onToggleMute,
  onToggleDeafen,
  onToggleNoiseFilter,
  onToggleCamera,
  onToggleScreenShare,
  onToggleMinimized,
  dock = false,
}: CallMediaProps) {
  const endRef = useRef<HTMLButtonElement>(null);

  const localCameraStream = useStablePickedStream(localStream, "camera");
  const localScreenStream = useStablePickedStream(localStream, "screen");
  const remoteCameraStream = useStablePickedStream(remoteStream, "camera");
  const remoteScreenStream = useStablePickedStream(remoteStream, "screen");

  const remoteIsScreen =
    remoteSharingScreen || Boolean(remoteScreenStream);
  const localIsScreen = sharingScreen && Boolean(localScreenStream);
  const screenMode = localIsScreen || remoteIsScreen;

  const remoteCamera =
    !remoteCameraOff && Boolean(remoteCameraStream);
  const localCamera = !cameraOff && Boolean(localCameraStream);
  const cameraMode = !screenMode && (remoteCamera || localCamera);

  const screenSources: { id: string; label: string; stream: MediaStream }[] = [];
  if (localIsScreen && localScreenStream) {
    screenSources.push({
      id: "local",
      label: "Ваш экран",
      stream: localScreenStream,
    });
  }
  if (remoteIsScreen && (remoteScreenStream || remoteStream)) {
    screenSources.push({
      id: "remote",
      label: "Экран собеседника",
      stream: remoteScreenStream || remoteStream!,
    });
  }

  useEffect(() => {
    const timer = window.setTimeout(() => endRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [active.peerId]);

  const ringing = isOutboundRinging(active.outbound, status);
  const statusText = ringing
    ? "Звоним…"
    : status === "На линии"
      ? durationLabel
      : status || "Звонок";

  return (
    <motion.div
      className={`call__card call__card--unified ${
        screenMode
          ? "call__card--screen"
          : cameraMode
            ? "call__card--camera"
            : "call__card--voice"
      } ${dock ? "call__card--dock" : ""} ${ringing ? "is-ringing" : ""}`}
      initial={dock ? { opacity: 0, y: -8 } : { opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={dock ? { opacity: 0, y: -6 } : { opacity: 0, scale: 0.98 }}
      transition={dock ? softSpring : sheetSpring}
      role="region"
      aria-label={`Звонок с ${active.peerName}`}
    >
      <button
        type="button"
        className="call__minimize"
        aria-label="Свернуть"
        onClick={onToggleMinimized}
      >
        <IconMinimize size={16} />
      </button>

      {networkQuality && (
        <div
          className={`call__qos call__qos--${networkQuality.level}`}
          title="Качество сети"
        >
          {networkQuality.rttMs} ms
        </div>
      )}

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
            <aside className="call__participants-rail" aria-label="Участники звонка">
              <div
                className={`call__tile ${
                  remoteCamera && remoteSpeaking ? "is-speaking" : ""
                } ${remoteCamera ? "has-video" : ""}`}
              >
                <MediaVideo
                  stream={remoteCameraStream || remoteStream}
                  active={Boolean(remoteStream)}
                  className={`call__tile-video ${remoteCamera ? "" : "is-hidden"}`}
                />
                {!remoteCamera && (
                  <div
                    className={`call__tile-avatar ${
                      remoteSpeaking ? "is-speaking" : ""
                    }`}
                  >
                    <Avatar
                      name={active.peerName}
                      src={peerAvatarUrl}
                      size="xl"
                    />
                  </div>
                )}
                <em className="call__tile-name">
                  <span>{active.peerName}</span>
                </em>
              </div>
              <div
                className={`call__tile call__tile--self ${
                  localCamera && localSpeaking ? "is-speaking" : ""
                } ${localCamera ? "has-video" : ""}`}
              >
                <MediaVideo
                  stream={localCameraStream || localStream}
                  active={Boolean(localStream)}
                  className={`call__tile-video is-camera ${localCamera ? "" : "is-hidden"}`}
                />
                {!localCamera && (
                  <div
                    className={`call__tile-avatar ${
                      localSpeaking ? "is-speaking" : ""
                    }`}
                  >
                    <Avatar
                      name="Вы"
                      src={selfAvatarUrl}
                      size="xl"
                    />
                  </div>
                )}
                <em className="call__tile-name">
                  <span>Вы</span>
                  {muted ? <IconMicOff size={14} className="call__tile-icon" /> : null}
                </em>
              </div>
            </aside>
          </div>
        ) : (
          <div className="call__tiles call__tiles--solo">
            <div
              className={`call__tile ${
                remoteCamera && remoteSpeaking ? "is-speaking" : ""
              } ${remoteCamera ? "has-video" : ""}`}
            >
              <MediaVideo
                stream={remoteCameraStream || remoteStream}
                active={Boolean(remoteStream)}
                className={`call__tile-video ${remoteCamera ? "" : "is-hidden"}`}
              />
              {!remoteCamera && (
                <div
                  className={`call__tile-avatar ${
                    remoteSpeaking ? "is-speaking" : ""
                  } ${ringing ? "call__ring call__ring--stage" : ""}`}
                >
                  <Avatar
                    name={active.peerName}
                    src={peerAvatarUrl}
                    size="xl"
                  />
                </div>
              )}
              <em className="call__tile-name">
                <span>{active.peerName}</span>
              </em>
              {ringing ? (
                <p className="call__calling" aria-live="polite">
                  Звоним…
                </p>
              ) : null}
            </div>
          </div>
        )}

        {localCamera && !screenMode ? (
          <div className="call__self-pip" aria-label="Ваша камера">
            <MediaVideo
              stream={localCameraStream || localStream}
              active={Boolean(localStream)}
              className="call__tile-video is-camera"
            />
          </div>
        ) : null}
      </div>

      <div className="call__bar">
        <p className="call__status">
          <strong>{active.peerName}</strong>
          <span>
            {statusText}
            {sharingScreen
              ? " · экран"
              : remoteIsScreen
                ? " · смотрите экран"
                : ""}
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
          {onToggleDeafen ? (
            <button
              type="button"
              className={`call__btn call__btn--circle ${deafened ? "is-off" : ""}`}
              onClick={onToggleDeafen}
              aria-label={deafened ? "Включить звук" : "Отключить звук"}
              title={deafened ? "Без звука" : "Наушники"}
            >
              <IconHeadphones size={20} />
            </button>
          ) : null}
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
            {cameraOff ? (
              <IconCameraOff size={20} />
            ) : (
              <IconCamera size={20} />
            )}
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
            onClick={onEnd}
            aria-label="Завершить"
            title="Завершить"
          >
            <IconPhoneOff size={20} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function CallMiniBar({
  peerName,
  peerAvatarUrl,
  speaking,
  statusLabel,
  sharingScreen,
  inline = false,
  onExpand,
  onEnd,
}: {
  peerName: string;
  peerAvatarUrl?: string | null;
  speaking?: boolean;
  statusLabel: string;
  sharingScreen?: boolean;
  inline?: boolean;
  onExpand: () => void;
  onEnd: () => void;
}) {
  return (
    <motion.div
      className={`call-mini ${inline ? "call-mini--inline" : ""}`}
      initial={{ opacity: 0, y: inline ? -8 : 16, scale: inline ? 1 : 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: inline ? -6 : 10, scale: inline ? 1 : 0.98 }}
      transition={softSpring}
    >
      <button
        type="button"
        className="call-mini__main"
        onClick={onExpand}
        aria-label={`Развернуть звонок с ${peerName}`}
      >
        <span className={`call-mini__avatar ${speaking ? "is-speaking" : ""}`}>
          <Avatar name={peerName} src={peerAvatarUrl} size="sm" />
        </span>
        <span>
          <strong>{peerName}</strong>
          <em>
            {statusLabel}
            {sharingScreen ? " · экран" : ""}
          </em>
        </span>
        <IconExpand size={16} />
      </button>
      <button
        type="button"
        className="call-mini__end"
        onClick={onEnd}
        aria-label="Завершить звонок"
        title="Завершить"
      >
        <IconPhoneOff size={16} />
      </button>
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

export function CallOverlay({
  incoming,
  active,
  localStream,
  remoteStream,
  muted,
  deafened = false,
  cameraOff,
  sharingScreen,
  mediaBusy = false,
  remoteSharingScreen,
  remoteCameraOff,
  peerAvatarUrl = null,
  selfAvatarUrl = null,
  incomingAvatarUrl = null,
  minimized,
  status,
  durationLabel,
  networkQuality = null,
  localSpeaking = false,
  remoteSpeaking = false,
  remoteAudioRef,
  currentChatId = null,
  noiseFilterEnabled = true,
  noiseFilterKind = "browser",
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onToggleDeafen,
  onToggleNoiseFilter,
  onToggleCamera,
  onToggleScreenShare,
  onToggleMinimized,
  onExpandCall,
}: CallOverlayProps) {
  const acceptRef = useRef<HTMLButtonElement>(null);
  const showIncoming = Boolean(incoming && !active);
  const callInThisChat = Boolean(
    active && currentChatId && active.chatId === currentChatId,
  );
  const showDock = Boolean(active && callInThisChat && !minimized && !showIncoming);
  const showInlineMini = Boolean(active && callInThisChat && minimized && !showIncoming);
  const showFloatMini = Boolean(active && !callInThisChat && !showIncoming);
  const screenKeepalives = useMemo(() => {
    const list: { id: string; label: string; stream: MediaStream }[] = [];
    const local = pickScreenStream(localStream);
    if (sharingScreen && local) {
      list.push({ id: "local", label: "Ваш экран", stream: local });
    }
    const remote = pickScreenStream(remoteStream);
    if (remoteSharingScreen && remote) {
      list.push({ id: "remote", label: "Экран собеседника", stream: remote });
    }
    return list;
  }, [localStream, remoteStream, remoteSharingScreen, sharingScreen]);

  useRingTone(showIncoming);
  useOutgoingRing(
    Boolean(active && isOutboundRinging(active.outbound, status)),
  );

  useEffect(() => {
    if (!showIncoming) return;
    const timer = window.setTimeout(() => acceptRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [showIncoming]);

  useEffect(() => {
    if (!showIncoming && !showDock) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (showIncoming) onReject();
      else if (showDock) onToggleMinimized();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showIncoming, showDock, onReject, onToggleMinimized]);

  useEffect(() => {
    void applyAudioOutput(remoteAudioRef.current);
  }, [remoteAudioRef, active]);

  return (
    <>
      <ScreenShareKeepalive sources={screenKeepalives} />
      <audio ref={remoteAudioRef} autoPlay playsInline hidden />

      <AnimatePresence>
        {showFloatMini && active && (
          <CallMiniBar
            peerName={active.peerName}
            peerAvatarUrl={peerAvatarUrl}
            speaking={remoteSpeaking}
            statusLabel={
              status === "На линии" ? durationLabel : status || "Звонок"
            }
            sharingScreen={sharingScreen}
            onExpand={() => onExpandCall?.()}
            onEnd={onEnd}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showIncoming && incoming && (
          <motion.div
            className="call"
            role="dialog"
            aria-modal="true"
            aria-label="Входящий звонок"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: easeOutSoft }}
          >
            <motion.div
              className="call__card call__card--incoming"
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={sheetSpring}
            >
              <div className="call__ring">
                <Avatar
                  name={incoming.fromName}
                  src={incomingAvatarUrl}
                  size="lg"
                />
              </div>
              <p className="call__label">Входящий звонок</p>
              <h2 className="call__name">{incoming.fromName}</h2>
              <div className="call__actions call__actions--dock">
                <button
                  type="button"
                  className="call__btn call__btn--circle call__btn--bad"
                  onClick={onReject}
                  aria-label="Отклонить"
                  title="Отклонить"
                >
                  <IconPhoneOff size={22} />
                </button>
                <button
                  ref={acceptRef}
                  type="button"
                  className="call__btn call__btn--circle call__btn--ok"
                  onClick={onAccept}
                  aria-label="Ответить"
                  title="Ответить"
                >
                  <IconPhone size={22} />
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showInlineMini && active ? (
          <DockPortal>
            <CallMiniBar
              peerName={active.peerName}
              peerAvatarUrl={peerAvatarUrl}
              speaking={remoteSpeaking}
              statusLabel={
                status === "На линии" ? durationLabel : status || "Звонок"
              }
              sharingScreen={sharingScreen}
              inline
              onExpand={onToggleMinimized}
              onEnd={onEnd}
            />
          </DockPortal>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showDock && active ? (
          <DockPortal>
            <CallPanel
              active={active}
              localStream={localStream}
              remoteStream={remoteStream}
              muted={muted}
              deafened={deafened}
              cameraOff={cameraOff}
              sharingScreen={sharingScreen}
              mediaBusy={mediaBusy}
              remoteSharingScreen={remoteSharingScreen}
              remoteCameraOff={remoteCameraOff}
              peerAvatarUrl={peerAvatarUrl}
              selfAvatarUrl={selfAvatarUrl}
              status={status}
              durationLabel={durationLabel}
              networkQuality={networkQuality}
              localSpeaking={localSpeaking}
              remoteSpeaking={remoteSpeaking}
              noiseFilterEnabled={noiseFilterEnabled}
              noiseFilterKind={noiseFilterKind}
              onEnd={onEnd}
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
