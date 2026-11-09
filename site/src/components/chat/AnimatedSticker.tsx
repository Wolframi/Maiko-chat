"use client";

import { useCallback, useEffect, useState, type VideoHTMLAttributes } from "react";
import { useMediaIntersection } from "@/hooks/useMediaIntersection";
import { mediaResourceKey, retryMediaSrc } from "@/lib/files";
import { MediaLoadingIndicator } from "./MediaLoadingIndicator";
import { useMediaDownload } from "@/hooks/useMediaDownload";

type Props = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> & { src: string };

export function AnimatedSticker(props: Props) {
  return <StickerResource key={mediaResourceKey(props.src)} {...props} />;
}

function StickerResource({ src, style, onLoadedData, onError, ...props }: Props) {
  const near = useMediaIntersection<HTMLVideoElement>();
  const visible = useMediaIntersection<HTMLVideoElement>("0px", false, near.ref);
  const [source] = useState(src);
  const [attempt, setAttempt] = useState(0);
  const [foreground, setForeground] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const active = visible.intersecting && foreground;
  const download = useMediaDownload(retryMediaSrc(attempt ? src : source, attempt), near.intersecting && !broken);
  const failed = useCallback(() => {
    setLoaded(false);
    if (attempt < 1) setAttempt(1); else setBroken(true);
  }, [attempt]);
  useEffect(() => { if (download.error) failed(); }, [download.error, failed]);

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
  }, [active, download.url, attempt, visible.ref]);

  const failure = broken ? <span role="button" tabIndex={0} className="bubble__media-retry"
    aria-label="Повторить загрузку" onClick={event => {
      event.preventDefault(); event.stopPropagation(); setBroken(false); setAttempt(value => value + 1);
    }} onKeyDown={event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); event.stopPropagation(); setBroken(false); setAttempt(value => value + 1);
      }
    }}>Не удалось загрузить стикер</span> : null;

  return (
    <><video {...props} ref={near.ref} style={{ ...style, ...(!loaded ? { opacity: 0 } : {}) }}
      src={download.url}
      autoPlay={active} loop muted playsInline preload={active ? "auto" : near.intersecting ? "metadata" : "none"}
      onLoadedData={event => { setLoaded(true); onLoadedData?.(event); }}
      onError={event => {
        failed();
        onError?.(event);
      }} />
    {failure || (near.intersecting && !loaded ? <MediaLoadingIndicator sticker progress={download} /> : null)}</>
  );
}
