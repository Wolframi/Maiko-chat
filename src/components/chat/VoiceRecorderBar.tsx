"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { IconClose, IconMic, IconSend, IconTrash } from "@/lib/icons";
import {
  captureFilteredMic,
  stopNoiseFilter,
  type NoiseFilterSession,
} from "@/lib/noiseFilter";

const MIN_SEND_MS = 1000;
const CANCEL_SLIDE_PX = 64;

/** Telegram-like: 0:01,3 (tenths after comma). */
function formatTime(ms: number) {
  const totalMs = Math.max(0, ms);
  const totalSec = Math.floor(totalMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const tenth = Math.floor((totalMs % 1000) / 100);
  return `${m}:${s.toString().padStart(2, "0")},${tenth}`;
}

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function extForMime(mime: string) {
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) {
    return "m4a";
  }
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

export type VoiceRecorderControls = {
  finish: () => void;
  cancel: () => void;
};

type VoiceRecorderBarProps = {
  onReady: (file: File) => void;
  onCancel: () => void;
  disabled?: boolean;
  /** hold = phone swipe UX; click = desktop buttons. */
  mode?: "hold" | "click";
  /** Negative when finger slides left (for cancel). */
  slideX?: number;
  onControls?: (controls: VoiceRecorderControls) => void;
};

export function VoiceRecorderBar({
  onReady,
  onCancel,
  disabled = false,
  mode = "hold",
  slideX = 0,
  onControls,
}: VoiceRecorderBarProps) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [level, setLevel] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const finishingRef = useRef(false);
  const noiseFilterRef = useRef<NoiseFilterSession | null>(null);
  const smoothLevelsRef = useRef<number[]>([]);
  const levelSmoothRef = useRef(0);
  const onReadyRef = useRef(onReady);
  const onCancelRef = useRef(onCancel);
  onReadyRef.current = onReady;
  onCancelRef.current = onCancel;

  function cleanupMedia() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    const filter = noiseFilterRef.current;
    noiseFilterRef.current = null;
    void stopNoiseFilter(filter);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analyserRef.current = null;
  }

  function drawFrame() {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssWidth = Math.max(120, canvas.clientWidth || 160);
    const cssHeight = Math.max(24, canvas.clientHeight || 28);
    const width = Math.floor(cssWidth * dpr);
    const height = Math.floor(cssHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    // Frequency data reacts more visibly to speech than time-domain alone.
    const freq = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freq);
    const time = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(time);

    ctx.clearRect(0, 0, width, height);

    const barWidth = Math.max(2 * dpr, 3 * dpr);
    const gap = Math.max(dpr, 1.5 * dpr);
    const step = barWidth + gap;
    const bars = Math.floor(width / step);
    const slice = Math.max(1, Math.floor(freq.length / bars));

    const smooth = smoothLevelsRef.current;
    while (smooth.length < bars) smooth.push(0.08);
    if (smooth.length > bars) smooth.length = bars;

    let framePeak = 0;
    for (let i = 0; i < bars; i += 1) {
      let sum = 0;
      const start = i * slice;
      for (let j = 0; j < slice; j += 1) {
        sum += freq[start + j] || 0;
      }
      const avg = sum / slice / 255;

      let tdPeak = 0;
      const tStart = Math.floor((i / bars) * time.length);
      const tEnd = Math.floor(((i + 1) / bars) * time.length);
      for (let j = tStart; j < tEnd; j += 1) {
        const v = Math.abs(time[j] - 128) / 128;
        if (v > tdPeak) tdPeak = v;
      }

      // Boost quiet speech so the wave clearly “moves” while talking.
      const boosted = Math.min(1, Math.pow(avg * 1.85 + tdPeak * 1.4, 0.72));
      const target = Math.min(1, 0.06 + boosted * 1.35);
      // Fast attack, slower release — feels alive while speaking.
      const k = target > smooth[i] ? 0.62 : 0.28;
      smooth[i] = smooth[i] * (1 - k) + target * k;
      const barLevel = smooth[i];
      if (barLevel > framePeak) framePeak = barLevel;

      const barHeight = Math.max(2 * dpr, barLevel * height * 0.96);
      const x = i * step;
      const y = (height - barHeight) / 2;
      const alpha = 0.4 + barLevel * 0.6;
      ctx.fillStyle = `rgba(109, 138, 173, ${alpha.toFixed(2)})`;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, barWidth, barHeight, dpr);
      } else {
        ctx.rect(x, y, barWidth, barHeight);
      }
      ctx.fill();
    }

    levelSmoothRef.current =
      levelSmoothRef.current * 0.55 + framePeak * 0.45;
    setLevel(levelSmoothRef.current);

    rafRef.current = requestAnimationFrame(drawFrame);
  }

  function cancelRecording() {
    if (finishingRef.current) return;
    finishingRef.current = true;
    cancelledRef.current = true;
    cleanupMedia();
    chunksRef.current = [];
    onCancelRef.current();
  }

  function finishRecording() {
    if (finishingRef.current || cancelledRef.current) return;
    finishingRef.current = true;

    const elapsed = startedAtRef.current
      ? Date.now() - startedAtRef.current
      : 0;
    const recorder = recorderRef.current;

    // Shorter than 1s — discard, don't send.
    if (!recorder || recorder.state === "inactive" || elapsed < MIN_SEND_MS) {
      cancelledRef.current = true;
      cleanupMedia();
      chunksRef.current = [];
      onCancelRef.current();
      return;
    }

    recorder.onstop = () => {
      const mime = mimeRef.current || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mime.split(";")[0] });
      chunksRef.current = [];
      cleanupMedia();
      if (cancelledRef.current || !blob.size) {
        onCancelRef.current();
        return;
      }
      const ext = extForMime(mime);
      const file = new File([blob], `voice-${Date.now()}.${ext}`, {
        type: blob.type || "audio/webm",
      });
      onReadyRef.current(file);
    };

    try {
      if (recorder.state === "recording") recorder.requestData();
      recorder.stop();
    } catch {
      cleanupMedia();
      onCancelRef.current();
    }
  }

  useEffect(() => {
    onControls?.({ finish: finishRecording, cancel: cancelRecording });
  }, [onControls]);

  useEffect(() => {
    cancelledRef.current = false;
    finishingRef.current = false;
    let mounted = true;

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Микрофон недоступен в этом браузере");
        }
        const { filter, stream } = await captureFilteredMic();
        if (!mounted || cancelledRef.current) {
          await stopNoiseFilter(filter);
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        noiseFilterRef.current = filter;

        streamRef.current = stream;
        const mime = pickMime();
        mimeRef.current = mime;

        // Start MediaRecorder before setting up visualization. AudioContext
        // resume can be slow on iOS/Android and used to cut off the first words.
        const recorderOptions: MediaRecorderOptions[] = mime
          ? [
              { mimeType: mime, audioBitsPerSecond: 48_000 },
              { mimeType: mime },
            ]
          : [{ audioBitsPerSecond: 48_000 }];
        let recorder: MediaRecorder | null = null;
        for (const options of recorderOptions) {
          try {
            recorder = new MediaRecorder(stream, options);
            break;
          } catch {
            /* try a looser option */
          }
        }
        if (!recorder) recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onerror = () => {
          if (!mounted) return;
          setError("Ошибка записи");
          cleanupMedia();
        };
        recorder.onstart = () => {
          if (!mounted || cancelledRef.current) return;
          startedAtRef.current = Date.now();
          setElapsedMs(0);
          timerRef.current = setInterval(() => {
            setElapsedMs(Date.now() - startedAtRef.current);
          }, 50);
          setReady(true);
        };
        // A single final chunk is more reliable on mobile Safari than a very
        // short timeslice; finishRecording still calls requestData before stop.
        recorder.start();

        // Visualization is optional and must never delay or cancel recording.
        try {
          const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext;
          const audioCtx = new AudioCtx();
          audioCtxRef.current = audioCtx;
          if (audioCtx.state === "suspended") {
            void audioCtx.resume().catch(() => undefined);
          }
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.18;
          analyser.minDecibels = -90;
          analyser.maxDecibels = -25;
          source.connect(analyser);
          analyserRef.current = analyser;
          drawFrame();
        } catch {
          /* recording continues without waveform */
        }
      } catch (err) {
        if (!mounted) return;
        const message =
          err instanceof Error &&
          /NotAllowed|Permission/i.test(err.name + err.message)
            ? "Разрешите доступ к микрофону"
            : "Не удалось начать запись";
        setError(message);
      }
    }

    void start();

    return () => {
      mounted = false;
      cancelledRef.current = true;
      cleanupMedia();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only recorder lifecycle
  }, []);

  const holdMode = mode === "hold";
  const cancelling = holdMode && slideX <= -CANCEL_SLIDE_PX;
  const slideProgress = holdMode
    ? Math.min(1, Math.abs(Math.min(0, slideX)) / CANCEL_SLIDE_PX)
    : 0;
  const slidePx = holdMode ? Math.max(-120, Math.min(0, slideX)) : 0;
  const tooShort = elapsedMs > 0 && elapsedMs < MIN_SEND_MS;
  const canSend = ready && !tooShort && !disabled && !error;

  if (error) {
    return (
      <div className="composer__voice-custom">
        <div className="composer__voice-error">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => onCancelRef.current()}
            aria-label="Закрыть"
          >
            <IconClose size={16} />
          </button>
        </div>
      </div>
    );
  }

  if (!holdMode) {
    return (
      <div
        className={`composer__voice-custom composer__voice-custom--click ${
          disabled ? "is-disabled" : ""
        }`}
        style={{ "--voice-level": String(level) } as CSSProperties}
      >
        <button
          type="button"
          className="composer__voice-discard"
          onClick={cancelRecording}
          disabled={disabled}
          aria-label="Удалить запись"
          title="Удалить"
        >
          <IconTrash size={18} />
        </button>

        <div className="composer__voice-center">
          <span
            className={`composer__voice-time is-recording ${
              tooShort ? "is-short" : ""
            }`}
          >
            <span className="composer__voice-dot" />
            {formatTime(elapsedMs)}
          </span>
          <canvas
            ref={canvasRef}
            className="composer__voice-canvas"
            aria-hidden
          />
        </div>

        <div className="composer__voice-actions">
          <button
            type="button"
            className="composer__voice-send"
            onClick={finishRecording}
            disabled={!canSend}
            aria-label="Отправить голосовое"
            title={tooShort ? "Запишите не меньше 1 сек" : "Отправить"}
          >
            <IconSend size={18} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`composer__voice-custom composer__voice-custom--hold ${
        disabled ? "is-disabled" : ""
      } ${cancelling ? "is-cancelling" : ""} ${
        slideProgress > 0.08 ? "is-sliding" : ""
      }`}
      style={
        {
          "--voice-slide": `${slidePx}px`,
          "--voice-slide-progress": String(slideProgress),
          "--voice-level": String(level),
        } as CSSProperties
      }
    >
      <div className="composer__voice-cancel-zone" aria-hidden>
        <div
          className={`composer__voice-trash ${cancelling ? "is-armed" : ""}`}
          style={{
            transform: `scale(${0.85 + slideProgress * 0.45})`,
            opacity: 0.35 + slideProgress * 0.65,
          }}
        >
          <IconTrash size={18} />
        </div>
        <div className="composer__voice-chevrons">
          <span>‹</span>
          <span>‹</span>
          <span>‹</span>
        </div>
        <span className="composer__voice-cancel-label">
          {cancelling ? "Отпустите — удалить" : "Влево — удалить"}
        </span>
      </div>

      <div className="composer__voice-center">
        <span
          className={`composer__voice-time is-recording ${
            tooShort ? "is-short" : ""
          }`}
        >
          <span className="composer__voice-dot" />
          {formatTime(elapsedMs)}
        </span>
        <canvas
          ref={canvasRef}
          className="composer__voice-canvas"
          aria-hidden
        />
      </div>

      <div
        className={`composer__voice-orb ${ready ? "is-live" : ""} ${
          cancelling ? "is-cancel" : ""
        }`}
        aria-hidden
        style={{
          transform: cancelling
            ? undefined
            : `scale(${1 + level * 0.18})`,
        }}
      >
        <span className="composer__voice-orb-ring" />
        <span className="composer__voice-orb-ring composer__voice-orb-ring--delay" />
        {cancelling ? <IconTrash size={18} /> : <IconMic size={18} />}
      </div>
    </div>
  );
}

export { CANCEL_SLIDE_PX, MIN_SEND_MS };
