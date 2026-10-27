"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useMediaIntersection } from "@/hooks/useMediaIntersection";
import { mediaResourceKey, retryMediaSrc, videoPosterSrc } from "@/lib/files";

export function VideoPreview({ src, className }: { src: string; className?: string }) {
  return <PreviewResource key={mediaResourceKey(src)} src={src} className={className} />;
}

function PreviewResource({ src, className }: { src: string; className?: string }) {
  const { ref, intersecting } = useMediaIntersection<HTMLVideoElement | HTMLImageElement>("800px");
  const [source] = useState(src);
  const poster = videoPosterSrc(source);
  const [posterFailed, setPosterFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const retry = () => {
    if (attempt >= 4 || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setAttempt(value => value + 1);
    }, 1500 * (attempt + 1));
  };

  if (poster && !posterFailed) return (
    <img ref={ref as RefObject<HTMLImageElement>} className={className} alt="Превью видео"
      src={intersecting ? poster : undefined} decoding="async"
      onError={() => setPosterFailed(true)} />
  );

  return <video key={attempt} ref={ref as RefObject<HTMLVideoElement>} className={className}
    src={intersecting ? retryMediaSrc(attempt ? src : source, attempt) : undefined}
    muted playsInline preload={intersecting ? "metadata" : "none"}
    controls={false} disablePictureInPicture
    onPlay={event => event.currentTarget.pause()}
    onLoadedData={event => {
      if (!event.currentTarget.videoWidth) retry();
      else if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    }}
    onError={retry} />;
}
