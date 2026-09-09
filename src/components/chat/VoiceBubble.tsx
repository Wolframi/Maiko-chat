"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  formatPlaybackTime,
  getLivePlaybackTime,
  getSmoothPlaybackTime,
  lockPlaybackDuration,
  playAudioTrack,
  seekAudioPlayback,
  toggleAudioPlayback,
  type AudioTrack,
} from "@/lib/audioPlayback";
import { useAudioPlaybackSelector } from "@/hooks/useAudioPlayback";
import { drawWaveBars, peaksFromAudioUrl } from "@/lib/waveform";

function audioDuration(...candidates: number[]) {
  for (const value of candidates) {
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

type VoiceBubbleProps = {
  src: string;
  mine?: boolean;
  track: AudioTrack;
};

function VoiceBubbleInner({ src, mine = false, track }: VoiceBubbleProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const peaksRef = useRef<number[]>([]);
  const mountedRef = useRef(true);
  const durationRef = useRef(0);
  const progressLockRef = useRef(0);
  const dragRef = useRef(false);
  const progressRef = useRef(0);

  const [loadWave, setLoadWave] = useState(false);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);

  const isCurrent = useAudioPlaybackSelector((state) => state.current?.id === track.id);
  const playing = useAudioPlaybackSelector(
    (state) => state.playing && state.current?.id === track.id,
  );
  const storeDuration = useAudioPlaybackSelector((state) =>
    state.current?.id === track.id ? state.duration : 0,
  );

  const waveColor = mine ? "#7a8590" : "#505058";
  const progressColor = mine ? "#f0f2f4" : "#6d8aad";
  const cursorColor = mine ? "#ffffff" : "#87a0be";

  const paint = useCallback(
    (progress = 0) => {
      const canvas = canvasRef.current;
      const peaks = peaksRef.current;
      if (!canvas || !peaks.length) return;
      drawWaveBars(canvas, peaks, {
        progress,
        color: waveColor,
        progressColor,
        cursor: progress > 0,
        cursorColor,
      });
    },
    [cursorColor, progressColor, waveColor],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setLoadWave(false);
    setReady(false);
    setDuration(0);
    setFailed(false);
    peaksRef.current = [];
    durationRef.current = 0;
    progressLockRef.current = 0;
    progressRef.current = 0;
  }, [src]);

  useEffect(() => {
    const node = wrapRef.current;
    let timer = 0;
    const reveal = () => setLoadWave(true);
    if (isCurrent) {
      timer = window.setTimeout(reveal, track.kind === "audio" ? 120 : 40);
    }
    if (!node) {
      return () => window.clearTimeout(timer);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reveal();
      },
      { rootMargin: "240px 0px", threshold: 0 },
    );
    io.observe(node);
    return () => {
      window.clearTimeout(timer);
      io.disconnect();
    };
  }, [isCurrent, track.kind]);

  useEffect(() => {
    if (!loadWave) return;
    const ac = new AbortController();
    const bars = 160;
    void peaksFromAudioUrl(src, bars, ac.signal).then((data) => {
      if (!mountedRef.current || ac.signal.aborted) return;
      if (!data?.peaks.length) {
        setFailed(true);
        return;
      }
      peaksRef.current = data.peaks;
      if (data.duration > 0) {
        durationRef.current = data.duration;
        progressLockRef.current = data.duration;
        setDuration(data.duration);
        if (isCurrent) lockPlaybackDuration(data.duration);
      }
      setFailed(false);
      setReady(true);
      paint(isCurrent ? progressRef.current : 0);
    });
    return () => ac.abort();
  }, [isCurrent, loadWave, paint, src, track.kind]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const ro = new ResizeObserver(() => paint(isCurrent ? progressRef.current : 0));
    ro.observe(canvas);
    paint(isCurrent ? progressRef.current : 0);
    return () => ro.disconnect();
  }, [isCurrent, paint, ready]);

  useEffect(() => {
    if (!isCurrent) {
      progressLockRef.current = durationRef.current;
      progressRef.current = 0;
      paint(0);
      return;
    }
    if (durationRef.current > 0) lockPlaybackDuration(durationRef.current);
    let raf = 0;
    const tick = () => {
      const now = getSmoothPlaybackTime();
      const incoming = audioDuration(durationRef.current, now.duration);
      if (incoming && (!progressLockRef.current || incoming < progressLockRef.current - 0.05)) {
        progressLockRef.current = incoming;
      }
      const total = progressLockRef.current || now.duration;
      const t = now.currentTime;
      const progress = total > 0 ? Math.min(Math.max(t / total, 0), 1) : 0;
      progressRef.current = progress;
      paint(progress);
      if (timeRef.current) {
        const show = now.playing || t > 0 ? t : total;
        timeRef.current.textContent = formatPlaybackTime(show);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [isCurrent, paint]);

  const seekFromClientX = useCallback(
    (clientX: number, target: HTMLElement) => {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const live = isCurrent ? getSmoothPlaybackTime() : getLivePlaybackTime();
      const d = audioDuration(
        progressLockRef.current,
        durationRef.current,
        live.duration,
        storeDuration,
        duration,
      );
      progressRef.current = ratio;
      paint(ratio);
      if (d <= 0) {
        void playAudioTrack(track);
        return;
      }
      const time = ratio * d;
      if (isCurrent) seekAudioPlayback(time);
      else void playAudioTrack(track, { time });
    },
    [duration, isCurrent, paint, storeDuration, track],
  );

  const handleToggle = useCallback(() => {
    if (isCurrent) {
      toggleAudioPlayback();
      return;
    }
    void playAudioTrack(track);
  }, [isCurrent, track]);

  const total = storeDuration || duration;
  const label = formatPlaybackTime(total);

  return (
    <div
      ref={wrapRef}
      className={`voice-bubble ${mine ? "voice-bubble--mine" : ""} ${playing ? "is-playing" : ""}`}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="voice-bubble__play"
        aria-label={playing ? "Пауза" : "Слушать"}
        onClick={handleToggle}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
            style={{ marginLeft: "2px" }}
          >
            <path d="M8 5.5v13l11-6.5L8 5.5Z" />
          </svg>
        )}
      </button>

      <div className="voice-bubble__body">
        <div
          className="voice-bubble__wave"
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
          {failed || !ready ? (
            <span className="voice-bubble__track voice-bubble__track--fallback" aria-hidden />
          ) : (
            <canvas
              ref={canvasRef}
              className="voice-bubble__canvas"
              aria-hidden
            />
          )}
        </div>
      </div>

      <span ref={timeRef} className="voice-bubble__time">
        {label}
      </span>
    </div>
  );
}

export const VoiceBubble = memo(VoiceBubbleInner, (prev, next) => {
  return (
    prev.src === next.src &&
    Boolean(prev.mine) === Boolean(next.mine) &&
    prev.track.id === next.track.id &&
    prev.track.messageId === next.track.messageId &&
    prev.track.roomId === next.track.roomId &&
    prev.track.kind === next.track.kind &&
    prev.track.title === next.track.title &&
    prev.track.author === next.track.author
  );
});
