"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import WaveSurfer from "wavesurfer.js";
import Regions from "wavesurfer.js/plugins/regions";
import type { Region } from "wavesurfer.js/plugins/regions";
import { IconClose, IconPause, IconPlay } from "@/lib/icons";
import {
  CUSTOM_MAX_SEC,
  titleFromFileName,
  trimAudioFile,
} from "@/lib/customRingtone";

type RingtoneTrimDialogProps = {
  open: boolean;
  file: File | null;
  initialStart?: number;
  initialEnd?: number;
  onCancel: () => void;
  onComplete: (payload: {
    trimmed: Blob;
    source: File;
    title: string;
    startSec: number;
    endSec: number;
  }) => void;
};

function formatTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec * 10) / 10;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function channelPeaks(buffer: AudioBuffer): Float32Array[] {
  const peaks: Float32Array[] = [];
  for (let i = 0; i < buffer.numberOfChannels; i++) {
    peaks.push(buffer.getChannelData(i));
  }
  return peaks;
}

export function RingtoneTrimDialog({
  open,
  file,
  initialStart = 0,
  initialEnd = 0,
  onCancel,
  onComplete,
}: RingtoneTrimDialogProps) {
  const waveRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region | null>(null);
  const offsetRef = useRef(0);
  const srcRef = useRef<string | null>(null);

  const [src, setSrc] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(CUSTOM_MAX_SEC);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !file) return;
    if (!srcRef.current) srcRef.current = URL.createObjectURL(file);
    setSrc(srcRef.current);
    setBusy(false);
    setError(null);
    setPlaying(false);
  }, [open, file]);

  useEffect(() => {
    if (open) return;
    if (srcRef.current) {
      URL.revokeObjectURL(srcRef.current);
      srcRef.current = null;
    }
    setSrc(null);
    setDuration(0);
    setPlaying(false);
  }, [open]);

  useEffect(() => {
    if (!open || !file || !src || !waveRef.current) return;

    const host = waveRef.current;
    let cancelled = false;
    let ws: WaveSurfer | null = null;
    const unsubs: Array<() => void> = [];

    const syncFromRegion = (region: Region) => {
      if (cancelled || !ws) return;
      setStart(region.start);
      setEnd(region.end);
      const time = clamp(
        region.start + offsetRef.current,
        region.start,
        Math.max(region.start, region.end - 0.01),
      );
      ws.setTime(time);
      setPlayhead(time);
    };

    void (async () => {
      try {
        const copy = await file.arrayBuffer();
        const ctx = new OfflineAudioContext(1, 128, 22050);
        const decoded = await ctx.decodeAudioData(copy);
        if (cancelled || !host.isConnected) return;

        const peaks = channelPeaks(decoded);
        const regions = Regions.create();
        ws = WaveSurfer.create({
          container: host,
          height: 120,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          waveColor: "#5c5c66",
          progressColor: "#8b93f7",
          cursorColor: "#fff",
          cursorWidth: 2,
          interact: true,
          dragToSeek: true,
          normalize: true,
          plugins: [regions],
        });
        wsRef.current = ws;

        unsubs.push(
          ws.on("timeupdate", (time) => {
            if (!cancelled) setPlayhead(time);
          }),
          ws.on("play", () => {
            if (!cancelled) setPlaying(true);
          }),
          ws.on("pause", () => {
            if (!cancelled) setPlaying(false);
          }),
          ws.on("finish", () => {
            if (!cancelled) setPlaying(false);
          }),
          ws.on("interaction", (time) => {
            const region = regionRef.current;
            if (!region) return;
            offsetRef.current = time - region.start;
          }),
          ws.on("error", () => {
            if (!cancelled) setError("Не удалось прочитать файл");
          }),
          regions.on("region-update", (region) => {
            if (region.id !== "trim") return;
            syncFromRegion(region);
          }),
          regions.on("region-updated", (region) => {
            if (region.id !== "trim") return;
            syncFromRegion(region);
          }),
          regions.on("region-clicked", (region, event) => {
            event.stopPropagation();
            const el = region.element;
            if (!el || !ws) return;
            const rect = el.getBoundingClientRect();
            const rel = clamp((event.clientX - rect.left) / rect.width, 0, 1);
            const time = region.start + rel * (region.end - region.start);
            offsetRef.current = time - region.start;
            ws.setTime(time);
            setPlayhead(time);
          }),
        );

        await ws.load(src, peaks, decoded.duration);
        if (cancelled) return;

        const safe = decoded.duration;
        const maxEnd = Math.min(safe || CUSTOM_MAX_SEC, CUSTOM_MAX_SEC);
        const from = Math.max(
          0,
          Math.min(initialStart, Math.max(0, safe - 0.2)),
        );
        const to =
          initialEnd > from
            ? Math.min(safe || initialEnd, from + CUSTOM_MAX_SEC, initialEnd)
            : maxEnd;
        const startSec = from;
        const endSec = Math.max(from + 0.2, to);
        const region = regions.addRegion({
          id: "trim",
          start: startSec,
          end: endSec,
          drag: true,
          resize: true,
          minLength: 0.2,
          maxLength: CUSTOM_MAX_SEC,
          color: "rgba(88, 101, 242, 0.32)",
        });
        regionRef.current = region;
        offsetRef.current = 0;
        setDuration(safe);
        setStart(startSec);
        setEnd(endSec);
        ws.setTime(startSec);
        setPlayhead(startSec);
      } catch {
        if (!cancelled) setError("Не удалось прочитать файл");
      }
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((off) => {
        try {
          off();
        } catch {
          /* ignore */
        }
      });
      regionRef.current = null;
      wsRef.current = null;
      try {
        ws?.destroy();
      } catch {
        /* ignore */
      }
      host.replaceChildren();
    };
  }, [open, file, src, initialStart, initialEnd]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  const title = useMemo(
    () => titleFromFileName(file?.name || "Свой рингтон"),
    [file],
  );

  function togglePreview() {
    const ws = wsRef.current;
    const region = regionRef.current;
    if (!ws || !region) return;
    if (ws.isPlaying()) {
      ws.pause();
      return;
    }
    const from = clamp(ws.getCurrentTime(), region.start, region.end - 0.02);
    void ws.play(from, region.end).catch(() => {
      setError("Не удалось проиграть фрагмент");
    });
  }

  async function handleApply() {
    if (!file || busy) return;
    const region = regionRef.current;
    const from = region?.start ?? start;
    const to = region?.end ?? end;
    setBusy(true);
    setError(null);
    wsRef.current?.pause();
    try {
      const trimmed = await trimAudioFile(file, from, to);
      onComplete({
        trimmed,
        source: file,
        title,
        startSec: from,
        endSec: to,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось обрезать рингтон",
      );
      setBusy(false);
    }
  }

  if (!open || !file || typeof document === "undefined") return null;

  return createPortal(
    <div className="avatar-crop ringtone-trim" role="presentation">
      <button
        type="button"
        className="avatar-crop__backdrop"
        aria-label="Закрыть"
        onClick={() => {
          if (!busy) onCancel();
        }}
      />
      <div
        className="avatar-crop__card ringtone-trim__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ringtone-trim-title"
      >
        <header className="avatar-crop__head">
          <h3 id="ringtone-trim-title">Обрезать рингтон</h3>
          <button
            type="button"
            className="icon-btn"
            aria-label="Закрыть"
            disabled={busy}
            onClick={onCancel}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="ringtone-trim__wave-wrap ringtone-trim__wave-wrap--native">
          <div ref={waveRef} className="ringtone-trim__wave" />
        </div>

        <div className="ringtone-trim__times">
          <span>От {formatTime(start)}</span>
          <span>{formatTime(end - start)}</span>
          <span>До {formatTime(end)}</span>
        </div>
        <p className="ringtone-trim__cursor">
          Точка прослушивания: {formatTime(playhead)}
        </p>

        <p className="avatar-crop__hint">
          Тяните синий кусок или его края — белый курсор едет вместе с ним.
          Клик ставит точку, от неё играет «Слушать». Не длиннее {CUSTOM_MAX_SEC}{" "}
          сек. Края смягчаются фейдом, чтобы не щёлкало.
        </p>

        {error ? <p className="avatar-crop__error">{error}</p> : null}

        <div className="avatar-crop__actions">
          <button
            type="button"
            className="ringtone-trim__play"
            disabled={busy || !duration}
            onClick={togglePreview}
          >
            {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
            {playing ? "Стоп" : "Слушать"}
          </button>
          <button
            type="button"
            className="avatar-crop__cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Отмена
          </button>
          <button
            type="button"
            className="avatar-crop__apply"
            disabled={busy || !duration}
            onClick={() => void handleApply()}
          >
            {busy ? "Сохраняем…" : "Готово"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
