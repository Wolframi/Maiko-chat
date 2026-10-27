"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useIsPresent } from "motion/react";
import { decodeMaikoAtoms, MaikoMolecules, PARTICLES_PER_MOLECULE } from "@/lib/maikoAtoms";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const TAU = Math.PI * 2;

export function HologramMaikoFallback({ onReady, startFormed = false }: { onReady?: (durationMs?: number) => void; startFormed?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const isPresent = useIsPresent();
  const presentRef = useRef(isPresent);
  const readyRef = useRef(onReady);

  useEffect(() => { presentRef.current = isPresent; }, [isPresent]);
  useEffect(() => { readyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !ctx) return;
    const controller = new AbortController();
    // A failed fallback must still release the loading scene.
    const loadTimeout = window.setTimeout(() => { controller.abort(); readyRef.current?.(0); }, 4000);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let atoms: MaikoMolecules | null = null;
    let width = 1, height = 1, dpr = 1, scale = 1;
    let raf = 0, last = 0, elapsed = startFormed ? 3 : 0, accumulator = 0;
    let exitAt: number | null = null;
    let pointer: { x: number; y: number } | null = null;
    let screen = new Float32Array(0);
    let innerScreen = new Float32Array(0);
    const batches: number[][] = Array.from({ length: 12 }, () => []);

    const render = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!atoms) return;
      const time = media.matches ? 1.2 : elapsed;
      const rotation = media.matches ? -0.1 : -0.1 + Math.sin(time * 1.2) * 0.08;
      const exit = media.matches || exitAt === null ? 0 : Math.min(1, (time - exitAt) / 0.38);
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      const tilt = -0.035 + (media.matches ? 0 : Math.sin(time * 1.8) * 0.045);
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const modelPointer = pointer && !media.matches ? {
        x: (pointer.x - width / 2) / scale,
        y: (height / 2 - pointer.y) / scale,
      } : null;
      // One bounded physics step per frame avoids a catch-up spiral on slower devices.
      if (accumulator >= 1 / 30 && !media.matches) {
        atoms.step(1 / 30, time, null, rotation);
        accumulator = Math.min(accumulator - 1 / 30, 1 / 30);
      }
      for (const batch of batches) batch.length = 0;
      const p = atoms.positions, normals = atoms.normals;
      for (let i = 0; i < p.length / 3; i++) {
        const k = i * 3;
        const phase = i * 2.399963;
        const delay = (i % 19) * 0.009 + (p[k + 1] + 1.2) * 0.15;
        const progress = Math.max(0, Math.min(1, (time - 0.7 - delay) / 1.1));
        const entry = media.matches ? 1 : progress * progress * (3 - 2 * progress);
        const scatter = (1 - entry) ** 2;
        const waveDistance = p[k + 1] - (1.45 - (time - 1.55) * 2.6);
        const wave = media.matches || time < 1.55 || time > 2.65 ? 0 : Math.exp(-waveDistance * waveDistance * 16);
        const proximity = modelPointer ? Math.exp(-((p[k] - modelPointer.x) ** 2 + (p[k + 1] - modelPointer.y) ** 2) * 12) : 0;
        const pulse = wave * 0.012 + proximity * Math.sin(time * 5 + phase) * 0.008;
        const px = p[k] + normals[k] * pulse;
        const py = p[k + 1] + normals[k + 1] * pulse;
        const pz = p[k + 2] + normals[k + 2] * pulse;
        const modelX = px * cos - pz * sin;
        const modelZ = px * sin + pz * cos;
        const modelY = py * ct - modelZ * st;
        const modelDepth = py * st + modelZ * ct;
        const spiral = phase + scatter * 5.5 + time * 0.5;
        const latitude = 1 - 2 * ((i * 0.61803398875) % 1);
        const ringRadius = Math.sqrt(Math.max(0, 1 - latitude * latitude));
        const radius = Math.min(1.32, Math.min(width, height) / scale * 0.4);
        const x = modelX * (1 - scatter) + Math.cos(spiral) * ringRadius * radius * scatter;
        const y = modelY * (1 - scatter) + latitude * radius * scatter;
        const depth = modelDepth * (1 - scatter) + Math.sin(spiral) * ringRadius * radius * scatter;
        const perspective = 4.8 / (4.8 - depth);
        const spread = exit * exit * (0.45 + (i % 7) * 0.13);
        screen[k] = width / 2 + (x * perspective + Math.cos(spiral) * spread) * scale;
        screen[k + 1] = height / 2 - (y * perspective + Math.sin(spiral) * spread * 0.65 + exit * exit * 0.65) * scale;
        const facing = normals[k] * sin + normals[k + 2] * cos;
        const brightness = (0.13 + Math.max(0, facing) * 0.78 + wave * 0.25 + proximity * 0.2) * (0.9 + 0.1 * Math.sin(phase + time * 1.5)) * Math.min(1, 0.3 + entry * 2);
        for (let child = 0; child < PARTICLES_PER_MOLECULE; child++) {
          const q = (i * PARTICLES_PER_MOLECULE + child) * 3;
          const dx = atoms.innerPositions[q] - p[k];
          const dy = atoms.innerPositions[q + 1] - p[k + 1];
          const dz = atoms.innerPositions[q + 2] - p[k + 2];
          const rx = dx * cos - dz * sin, rz = dx * sin + dz * cos;
          innerScreen[q] = screen[k] + rx * scale * perspective;
          innerScreen[q + 1] = screen[k + 1] - (dy * ct - rz * st) * scale * perspective;
          innerScreen[q + 2] = Math.max(0.64, scale * 0.0025) * perspective * (0.88 + child * 0.08);
        }
        const bucket = Math.min(11, Math.floor(brightness * 12));
        if (brightness > 0.025) batches[bucket].push(k);
      }
      ctx.fillStyle = "#ffffff";
      for (let b = 0; b < batches.length; b++) {
        // Only white pinpoints are rendered; their interaction groups stay invisible.
        ctx.globalAlpha = Math.min(1, (b + 1) / 12 * 1.3);
        ctx.beginPath();
        for (const k of batches[b]) {
          for (let child = 0; child < PARTICLES_PER_MOLECULE; child++) {
            const q = (k / 3 * PARTICLES_PER_MOLECULE + child) * 3;
            ctx.moveTo(innerScreen[q] + innerScreen[q + 2], innerScreen[q + 1]);
            ctx.arc(innerScreen[q], innerScreen[q + 1], innerScreen[q + 2], 0, TAU);
          }
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      scale = Math.min(width * 0.54, height * 0.32, 280);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      render();
    };
    const loop = (now: number) => {
      raf = 0;
      const delta = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      elapsed += delta;
      if (!presentRef.current && exitAt === null) exitAt = elapsed;
      accumulator = Math.min(accumulator + delta, 1 / 15);
      render();
      if (!media.matches && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const resume = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      accumulator = 0;
      if (document.hidden || !atoms) return;
      if (media.matches) {
        render();
      } else raf = requestAnimationFrame(loop);
    };
    const move = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
    const leave = () => { pointer = null; };
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", leave, { passive: true });
    window.addEventListener("blur", leave);
    document.documentElement.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", resume);
    media.addEventListener("change", resume);

    void fetch("/models/maiko-atoms.bin", { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Maiko point cloud: ${response.status}`);
        return response.arrayBuffer();
      })
      .then(buffer => {
        if (controller.signal.aborted) return;
        const data = decodeMaikoAtoms(buffer, width < 600 ? 1800 : 3600);
        atoms = new MaikoMolecules(data.anchors, data.normals);
        screen = new Float32Array(data.anchors.length);
        innerScreen = new Float32Array(atoms.innerPositions.length);
        clearTimeout(loadTimeout);
        canvas.dataset.maikoRenderer = "canvas";
        resume();
        readyRef.current?.();
      })
      .catch(error => {
        if (!controller.signal.aborted) console.warn("Unable to load Maiko intro", error);
        clearTimeout(loadTimeout);
        if (!controller.signal.aborted) readyRef.current?.(0);
      });

    return () => {
      clearTimeout(loadTimeout); controller.abort();
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", leave);
      window.removeEventListener("blur", leave);
      document.documentElement.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", resume);
      media.removeEventListener("change", resume);
    };
  }, [mounted,startFormed]);

  if (!mounted) return null;
  return createPortal(
    <canvas ref={canvasRef} className={`hologram-maiko${isPresent ? "" : " is-exiting"}`} aria-hidden="true" />,
    document.body,
  );
}
