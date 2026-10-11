"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useIsPresent } from "motion/react";
import { chooseMaikoIntro, createMaikoCanvasRenderer, createMaikoRenderer, maikoIntroAsset, maikoIntroDuration, type MaikoIntro } from "@/lib/maikoDance";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function HologramMaiko({ onReady }: { onReady?: (durationMs?: number) => void }) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPresent = useIsPresent();
  const presentRef = useRef(isPresent);
  const readyRef = useRef(onReady);
  const introRef = useRef<MaikoIntro | null>(null);
  const startRandomRef = useRef<number | null>(null);
  const bufferRef = useRef<ArrayBuffer | null>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => { presentRef.current = isPresent; }, [isPresent]);
  useEffect(() => { readyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const intro = introRef.current ?? (introRef.current = chooseMaikoIntro(Math.random()));
    const startRandom = startRandomRef.current ?? (startRandomRef.current = Math.random());
    canvas.dataset.maikoIntro = intro;
    const controller = new AbortController();
    const fail = () => { if (fallback) readyRef.current?.(0); else setFallback(true); };
    const loadTimeout = window.setTimeout(() => { controller.abort(); fail(); }, 4500);
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let renderer: ReturnType<typeof createMaikoRenderer> | null = null;
    let width = 1, height = 1, dpr = 1, raf = 0, last = 0, elapsed = 0;
    let exitAt: number | null = null;
    let pointer: {x:number;y:number} | null = null;
    const draw = () => renderer?.draw(width,height,dpr,media.matches ? 1.2 : elapsed,!media.matches,
      exitAt === null || media.matches ? 0 : Math.min(1,(elapsed-exitAt)/0.38),pointer);
    const resize = () => {
      width = innerWidth; height = innerHeight; dpr = Math.min(devicePixelRatio || 1,2);
      canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
      draw();
    };
    const loop = (now: number) => {
      raf = 0;
      elapsed += last ? Math.min((now-last)/1000,0.1) : 0;
      last = now;
      if (!presentRef.current && exitAt === null) exitAt = elapsed;
      draw();
      if (!document.hidden && !media.matches) raf = requestAnimationFrame(loop);
    };
    const resume = () => {
      cancelAnimationFrame(raf); raf = 0; last = 0;
      if (!renderer || document.hidden) return;
      if (media.matches) draw(); else raf = requestAnimationFrame(loop);
    };
    const move = (event: PointerEvent) => { pointer = {x:event.clientX,y:event.clientY}; };
    const leave = () => { pointer = null; };
    const lost = (event: Event) => { event.preventDefault(); fail(); };
    resize();
    window.addEventListener("resize",resize);
    window.addEventListener("pointermove",move,{passive:true});
    window.addEventListener("pointerup",leave,{passive:true});
    window.addEventListener("blur",leave);
    document.documentElement.addEventListener("pointerleave",leave);
    document.addEventListener("visibilitychange",resume);
    media.addEventListener("change",resume);
    canvas.addEventListener("webglcontextlost",lost);
    const asset = bufferRef.current ? Promise.resolve(bufferRef.current) : fetch(maikoIntroAsset(intro),{signal:controller.signal})
      .then(response => { if (!response.ok) throw new Error("Maiko dance unavailable"); return response.arrayBuffer(); });
    void asset
      .then(buffer => {
        if (controller.signal.aborted) return;
        clearTimeout(loadTimeout);
        bufferRef.current = buffer;
        renderer = fallback
          ? createMaikoCanvasRenderer(canvas,buffer,width < 600 ? 7000 : 14000,startRandom)
          : createMaikoRenderer(canvas,buffer,width < 600 ? 40000 : 84000,startRandom);
        canvas.dataset.maikoRenderer = fallback ? "canvas" : "webgl";
        canvas.dataset.maikoDanceStart = renderer.startSeconds.toFixed(3);
        resume();
        readyRef.current?.(maikoIntroDuration[intro]);
      })
      .catch(() => { clearTimeout(loadTimeout); if (!controller.signal.aborted) fail(); });
    return () => {
      clearTimeout(loadTimeout); controller.abort(); cancelAnimationFrame(raf); renderer?.dispose();
      window.removeEventListener("resize",resize);
      window.removeEventListener("pointermove",move);
      window.removeEventListener("pointerup",leave);
      window.removeEventListener("blur",leave);
      document.documentElement.removeEventListener("pointerleave",leave);
      document.removeEventListener("visibilitychange",resume);
      media.removeEventListener("change",resume);
      canvas.removeEventListener("webglcontextlost",lost);
    };
  },[mounted,fallback]);

  if (!mounted) return null;
  return createPortal(<canvas key={fallback ? "canvas" : "webgl"} ref={canvasRef} className={`hologram-maiko${isPresent ? "" : " is-exiting"}`} aria-hidden="true" />,document.body);
}
