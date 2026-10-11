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
  const buffering = useAudioPlaybackSelector((state) => state.buffering);
  const duration = useAudioPlaybackSelector((state) => state.duration);
  const currentTime = useAudioPlaybackSelector((state) => state.currentTime);
  const volume = useAudioPlaybackSelector((state) => state.volume);
  const playbackRate = useAudioPlaybackSelector((state) => state.playbackRate);
  const dragRef = useRef(false);
  const dragTimeRef = useRef<number | null>(null);
  const volDragRef = useRef(false);
  const volumeRef = useRef<HTMLDivElement>(null);
  const touchVolumeButtonRef = useRef(false);
  const progressRef = useRef<HTMLElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const holdRatioRef = useRef<number | null>(null);
  const [volHover, setVolHover] = useState(false);
  const [volDrag, setVolDrag] = useState(false);
  const [volTouchOpen, setVolTouchOpen] = useState(false);
  const volLeaveRef = useRef<number>(0);

  const seekVolumeFromClientX = useCallback((clientX: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    setAudioVolume(Math.min(1, Math.max(0, ratio)));
  }, []);

  const seekFromClientX = useCallback((clientX: number, target: HTMLElement, commit: boolean) => {
    const live = getSmoothPlaybackTime();
    const total = live.duration || duration;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || total <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    dragTimeRef.current = ratio * total;
    holdRatioRef.current = ratio;
    if (progressRef.current) progressRef.current.style.width = `${ratio * 100}%`;
    if (elapsedRef.current) elapsedRef.current.textContent = formatPlaybackTime(ratio * total);
    if (commit) seekAudioPlayback(ratio * total);
  }, [duration]);

  const commitDraggedSeek = useCallback(() => {
    if (dragTimeRef.current == null) return;
    seekAudioPlayback(dragTimeRef.current);
    dragTimeRef.current = null;
  }, []);

  useEffect(() => {
    if (!volTouchOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!volumeRef.current?.contains(event.target as Node)) setVolTouchOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePress, true);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePress, true);
  }, [volTouchOpen]);

  useEffect(() => {
    if (!visible || !track) return;
    let raf = 0;
    const tick = () => {
      if (!dragRef.current) {
        const live = getSmoothPlaybackTime();
        const total = live.duration;
        let progress = total > 0 ? Math.min(live.currentTime / total, 1) : 0;
        if (!live.playing && holdRatioRef.current != null) progress = holdRatioRef.current;
        if (live.playing) holdRatioRef.current = null;
        if (progressRef.current) progressRef.current.style.width = `${progress * 100}%`;
        if (elapsedRef.current) {
          const show = live.playing || progress > 0 ? progress * total : 0;
          elapsedRef.current.textContent = formatPlaybackTime(show);
        }
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
            className={`audio-bar__play ${buffering ? "is-buffering" : ""}`}
            aria-label={playing ? "Пауза" : "Слушать"}
            aria-busy={buffering || undefined}
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
          ref={volumeRef}
          className={`audio-bar__volume ${volHover || volDrag || volTouchOpen ? "is-open" : ""}`}
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
            aria-expanded={volTouchOpen}
            onPointerDown={(event) => {
              if (event.pointerType === "mouse") return;
              touchVolumeButtonRef.current = true;
              window.clearTimeout(volLeaveRef.current);
              setVolTouchOpen((open) => !open);
            }}
            onClick={() => {
              if (touchVolumeButtonRef.current) {
                touchVolumeButtonRef.current = false;
                return;
              }
              toggleAudioMute();
            }}
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
              aria-orientation="horizontal"
              tabIndex={0}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 0.1 : 0.05;
                let next = volume;
                if (event.key === "ArrowRight" || event.key === "ArrowUp") next += step;
                else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= step;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = 1;
                else return;
                event.preventDefault();
                setAudioVolume(next);
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                volDragRef.current = true;
                setVolDrag(true);
                event.currentTarget.setPointerCapture(event.pointerId);
                seekVolumeFromClientX(event.clientX, event.currentTarget);
              }}
              onPointerMove={(event) => {
                if (!volDragRef.current) return;
                seekVolumeFromClientX(event.clientX, event.currentTarget);
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
        aria-valuenow={Math.round(Math.min(currentTime, duration || currentTime))}
        tabIndex={0}
        onKeyDown={(event) => {
          const total = getSmoothPlaybackTime().duration || duration;
          if (total <= 0) return;
          const liveTime = getSmoothPlaybackTime().currentTime;
          let next = liveTime;
          if (event.key === "ArrowRight" || event.key === "ArrowUp") next += 5;
          else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= 5;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = total;
          else return;
          event.preventDefault();
          seekAudioPlayback(Math.min(total, Math.max(0, next)));
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          dragRef.current = true;
          dragTimeRef.current = null;
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromClientX(event.clientX, event.currentTarget, false);
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          seekFromClientX(event.clientX, event.currentTarget, false);
        }}
        onPointerUp={(event) => {
          if (!dragRef.current) return;
          seekFromClientX(event.clientX, event.currentTarget, false);
          commitDraggedSeek();
          dragRef.current = false;
        }}
        onPointerCancel={() => {
          commitDraggedSeek();
          dragRef.current = false;
        }}
        onLostPointerCapture={() => {
          if (!dragRef.current) return;
          commitDraggedSeek();
          dragRef.current = false;
        }}
      >
        <i ref={progressRef} />
      </div>
    </div>
  );
}
