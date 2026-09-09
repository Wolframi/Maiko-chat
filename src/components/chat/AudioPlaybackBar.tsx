"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cycleAudioPlaybackRate,
  formatPlaybackTime,
  getSmoothPlaybackTime,
  peekAdjacentTrack,
  seekAudioPlayback,
  setAudioVolume,
  skipAudioPlayback,
  stopAudioPlayback,
  toggleAudioMute,
  toggleAudioPlayback,
} from "@/lib/audioPlayback";
import { formatAudioSentAt } from "@/lib/dates";
import { useAudioPlaybackSelector } from "@/hooks/useAudioPlayback";
import {
  IconClose,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipForward,
  IconVolume,
  IconVolumeOff,
} from "@/lib/icons";

type AudioPlaybackBarProps = {
  currentRoomId?: string | null;
  chats?: { id: string; title: string }[];
  onFocusTrack?: (roomId: string, messageId: string) => void;
};

function trackTitle(kind: "voice" | "audio", title: string) {
  if (kind === "voice") return "Голосовое сообщение";
  return title.replace(/\.[a-z0-9]{2,5}$/i, "") || title;
}

export function AudioPlaybackBar({
  currentRoomId,
  chats = [],
  onFocusTrack,
}: AudioPlaybackBarProps) {
  const visible = useAudioPlaybackSelector((state) => state.visible);
  const track = useAudioPlaybackSelector((state) => state.current);
  const playing = useAudioPlaybackSelector((state) => state.playing);
  const duration = useAudioPlaybackSelector((state) => state.duration);
  const volume = useAudioPlaybackSelector((state) => state.volume);
  const playbackRate = useAudioPlaybackSelector((state) => state.playbackRate);
  const dragRef = useRef(false);
  const volDragRef = useRef(false);
  const progressRef = useRef<HTMLElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const [volHover, setVolHover] = useState(false);
  const [volDrag, setVolDrag] = useState(false);
  const volLeaveRef = useRef<number>(0);

  const seekVolumeFromClientY = useCallback((clientY: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = 1 - (clientY - rect.top) / rect.height;
    setAudioVolume(Math.min(1, Math.max(0, ratio)));
  }, []);

  const seekFromClientX = useCallback((clientX: number, target: HTMLElement) => {
    const live = getSmoothPlaybackTime();
    const total = live.duration;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || total <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seekAudioPlayback(ratio * total);
  }, []);

  useEffect(() => {
    if (!visible || !track) return;
    let raf = 0;
    const tick = () => {
      const live = getSmoothPlaybackTime();
      const total = live.duration;
      const progress = total > 0 ? Math.min(live.currentTime / total, 1) : 0;
      if (progressRef.current) progressRef.current.style.width = `${progress * 100}%`;
      if (elapsedRef.current) {
        const show = live.playing || live.currentTime > 0 ? live.currentTime : 0;
        elapsedRef.current.textContent = formatPlaybackTime(show);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [track, visible]);

  if (!visible || !track) return null;

  const away = Boolean(currentRoomId && currentRoomId !== track.roomId);
  const chatTitle = chats.find((chat) => chat.id === track.roomId)?.title || "";
  const sent = formatAudioSentAt(track.createdAt);
  const sentLabel = away && chatTitle ? chatTitle : sent;
  const title = trackTitle(track.kind, track.title);
  const hasPrev = Boolean(peekAdjacentTrack(-1, track));
  const hasNext = Boolean(peekAdjacentTrack(1, track));
  const volumePercent = Math.round(volume * 100);
  const rateLabel = `${playbackRate}X`.replace(".0X", "X");

  return (
    <div className="audio-bar" role="region" aria-label="Сейчас играет">
      <div className="audio-bar__row">
        <div className="audio-bar__transport">
          <button
            type="button"
            className="audio-bar__icon"
            aria-label="Предыдущий"
            disabled={!hasPrev}
            onClick={() => skipAudioPlayback(-1)}
          >
            <IconSkipBack size={16} />
          </button>
          <button
            type="button"
            className="audio-bar__play"
            aria-label={playing ? "Пауза" : "Слушать"}
            onClick={() => toggleAudioPlayback()}
          >
            {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>
          <button
            type="button"
            className="audio-bar__icon"
            aria-label="Следующий"
            disabled={!hasNext}
            onClick={() => skipAudioPlayback(1)}
          >
            <IconSkipForward size={16} />
          </button>
        </div>

        <button
          type="button"
          className="audio-bar__meta"
          onClick={() => onFocusTrack?.(track.roomId, track.messageId)}
        >
          <strong>{title}</strong>
          <span>
            <span ref={elapsedRef}>0:00</span>
            {sentLabel ? ` • ${sentLabel}` : ""}
          </span>
        </button>

        <div
          className={`audio-bar__volume ${volHover || volDrag ? "is-open" : ""}`}
          onMouseEnter={() => {
            window.clearTimeout(volLeaveRef.current);
            setVolHover(true);
          }}
          onMouseLeave={() => {
            if (volDragRef.current) return;
            volLeaveRef.current = window.setTimeout(() => setVolHover(false), 120);
          }}
          onPointerEnter={() => {
            window.clearTimeout(volLeaveRef.current);
            setVolHover(true);
          }}
          onPointerLeave={() => {
            if (volDragRef.current) return;
            volLeaveRef.current = window.setTimeout(() => setVolHover(false), 120);
          }}
        >
          <button
            type="button"
            className="audio-bar__icon"
            aria-label={volume <= 0 ? "Включить звук" : "Выключить звук"}
            title={volume <= 0 ? "Включить звук" : "Выключить звук"}
            onClick={() => toggleAudioMute()}
          >
            {volume <= 0 ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
          </button>
          <div className="audio-bar__vol-pop">
            <span>{volumePercent}</span>
            <div
              className="audio-bar__vol-track"
              role="slider"
              aria-label="Громкость"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={volumePercent}
              aria-orientation="vertical"
              onPointerDown={(event) => {
                volDragRef.current = true;
                setVolDrag(true);
                event.currentTarget.setPointerCapture(event.pointerId);
                seekVolumeFromClientY(event.clientY, event.currentTarget);
              }}
              onPointerMove={(event) => {
                if (!volDragRef.current) return;
                seekVolumeFromClientY(event.clientY, event.currentTarget);
              }}
              onPointerUp={() => {
                volDragRef.current = false;
                setVolDrag(false);
              }}
              onPointerCancel={() => {
                volDragRef.current = false;
                setVolDrag(false);
              }}
            >
              <i style={{ height: `${volumePercent}%` }} />
            </div>
          </div>
        </div>

        <button
          type="button"
          className="audio-bar__rate"
          title="Скорость воспроизведения"
          onClick={() => cycleAudioPlaybackRate()}
        >
          {rateLabel}
        </button>

        <button
          type="button"
          className="audio-bar__icon"
          aria-label="Закрыть"
          title="Закрыть"
          onClick={() => stopAudioPlayback()}
        >
          <IconClose size={16} />
        </button>
      </div>

      <div
        className="audio-bar__progress"
        role="slider"
        aria-label="Прогресс"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={0}
        onPointerDown={(event) => {
          dragRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromClientX(event.clientX, event.currentTarget);
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          seekFromClientX(event.clientX, event.currentTarget);
        }}
        onPointerUp={() => {
          dragRef.current = false;
        }}
        onPointerCancel={() => {
          dragRef.current = false;
        }}
      >
        <i ref={progressRef} />
      </div>
    </div>
  );
}
