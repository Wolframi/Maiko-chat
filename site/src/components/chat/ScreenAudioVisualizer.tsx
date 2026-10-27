"use client";

import { useEffect, useRef } from "react";
import { getScreenAudioOwnerWindow, getScreenAudioTracks } from "@/lib/screenAudioSignal";
import { createScreenAudioBlob } from "@/lib/screenAudioBlob";

export function ScreenAudioVisualizer({
  stream,
}: {
  stream: MediaStream | null | undefined;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas || !stream) return;
    const blob = createScreenAudioBlob(canvas);
    root.dataset.renderer = blob ? "webgl" : "fallback";
    const owner = getScreenAudioOwnerWindow();
    let context: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let silentOutput: GainNode | null = null;
    let sources: MediaStreamAudioSourceNode[] = [];
    let boundTracks: MediaStreamTrack[] = [];
    let frame = 0;
    let lastTick = 0;
    let signalUntil = 0;
    let retryAfter = 0;
    let resumeAfter = 0;
    const samples = new Float32Array(512);
    let level = 0;
    let animationTime = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resume = () => {
      if (context && context.state !== "running" && context.state !== "closed") {
        void context.resume().catch(() => {});
      }
    };
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (document.hidden || now - lastTick < (reducedMotion.matches ? 160 : 48)) return;
      const delta = Math.min((now - lastTick) / 1000, 0.16);
      lastTick = now;
      const tracks = getScreenAudioTracks(stream);
      if (now >= retryAfter && (tracks.length !== boundTracks.length ||
        tracks.some((track, index) => track !== boundTracks[index]))) {
        sources.forEach((source) => source.disconnect());
        sources = [];
        signalUntil = 0;
        try {
          if (tracks.length) {
            // A refreshed UI iframe may have no user activation. The desktop
            // owner's document already owns the native capture and audio grant.
            context ??= new owner.AudioContext();
            if (!analyser) {
              analyser = context.createAnalyser();
              analyser.fftSize = 512;
              analyser.smoothingTimeConstant = 0.65;
              silentOutput = context.createGain();
              silentOutput.gain.value = 0;
              analyser.connect(silentOutput).connect(context.destination);
            }
            sources = tracks.map((track) => {
              const source = context!.createMediaStreamSource(new owner.MediaStream([track]));
              source.connect(analyser!);
              return source;
            });
            // The zero-gain sink keeps native capture processing pulled while
            // never replaying screen audio or duplicating remote playback.
            resume();
          }
          boundTracks = tracks;
        } catch {
          boundTracks = [];
          retryAfter = now + 1000;
        }
      }

      if (tracks.length && now >= resumeAfter) {
        resumeAfter = now + 1000;
        resume();
      }
      root.dataset.audioContext = context?.state ?? "idle";

      let audible = false;
      let nextLevel = 0;
      if (analyser && context?.state === "running" &&
        tracks.some((track) => track.enabled && !track.muted)) {
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const rms = Math.sqrt(energy / samples.length);
        audible = rms > 0.0003;
        if (audible) signalUntil = now + 180;
        // Give quiet screen audio a visible pulse, without clipping loud peaks.
        if (audible) nextLevel = Math.min(0.9, Math.sqrt(rms) * 2.2);
      }
      const active = tracks.length > 0 && now < signalUntil;
      root.dataset.audioActive = String(active);
      level += (nextLevel - level) * (nextLevel > level ? 0.65 : 0.25);
      if (level < 0.001) level = 0;
      if (active && !reducedMotion.matches) animationTime += delta;
      root.style.setProperty("--screen-audio-level", level.toFixed(3));
      blob?.render(animationTime, level);
    };
    frame = requestAnimationFrame(draw);
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    if (owner !== window) {
      owner.addEventListener("pointerdown", resume);
      owner.addEventListener("keydown", resume);
    }
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      if (owner !== window) {
        owner.removeEventListener("pointerdown", resume);
        owner.removeEventListener("keydown", resume);
      }
      window.removeEventListener("pagehide", cleanup);
      sources.forEach((source) => source.disconnect());
      analyser?.disconnect();
      silentOutput?.disconnect();
      blob?.dispose();
      if (context) void context.close().catch(() => {});
    };
    window.addEventListener("pagehide", cleanup, { once: true });
    return cleanup;
  }, [stream]);

  return (
    <span ref={rootRef} className="screen-audio-visualizer" role="img"
      aria-label="Аудиовизуализатор демонстрации экрана" data-audio-active="false">
      <canvas ref={canvasRef} aria-hidden="true" />
    </span>
  );
}
