"use client";

import { useEffect, useState, type VideoHTMLAttributes } from "react";
import { useMediaIntersection } from "@/hooks/useMediaIntersection";
import { mediaResourceKey, retryMediaSrc } from "@/lib/files";

type Props = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> & { src: string };

export function AnimatedSticker(props: Props) {
  return <StickerResource key={mediaResourceKey(props.src)} {...props} />;
}

function StickerResource({ src, ...props }: Props) {
  const near = useMediaIntersection<HTMLVideoElement>();
  const visible = useMediaIntersection<HTMLVideoElement>("0px", false, near.ref);
  const [source] = useState(src);
  const [attempt, setAttempt] = useState(0);
  const [foreground, setForeground] = useState(true);
  const active = visible.intersecting && foreground;

  useEffect(() => {
    const update = () => setForeground(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const video = visible.ref.current;
    if (!video) return;
    if (active) void video.play().catch(() => {});
    else video.pause();
  }, [active, near.intersecting, attempt, visible.ref]);

  return (
    <video {...props} ref={near.ref}
      src={near.intersecting ? retryMediaSrc(attempt ? src : source, attempt) : undefined}
      autoPlay={active} loop muted playsInline preload={active ? "auto" : near.intersecting ? "metadata" : "none"}
      onError={() => { if (attempt < 1) setAttempt(1); }} />
  );
}
