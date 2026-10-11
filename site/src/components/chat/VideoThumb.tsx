"use client";

import { useEffect, useRef, useState } from "react";
import { isLocalMediaUrl, mediaSrc, signedMediaSrc } from "@/lib/files";
import { IconPlay } from "@/lib/icons";

type VideoThumbProps = {
  url: string;
  onOpen?: () => void;
};

/**
 * Inline chat video preview. Retries with a cache-buster when Chrome gets
 * audio-only HEVC (or a stale cached copy) while the server finishes H.264.
 */
export function VideoThumb({ url, onOpen }: VideoThumbProps) {
  const base = signedMediaSrc(url) || mediaSrc(url);
  const [bust, setBust] = useState(0);
  const tries = useRef(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  const src = bust > 0 && !isLocalMediaUrl(base) ? `${base}${base.includes("?") ? "&" : "?"}v=${bust}` : base;

  useEffect(() => {
    tries.current = 0;
    setBust(0);
  }, [base]);

  useEffect(() => {
    const node = buttonRef.current;
    if (!node || near) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="bubble__video-btn"
      onClick={onOpen}
      aria-label="Открыть видео"
    >
      { }
      <video
        key={src}
        className="bubble__video"
        src={near ? src : undefined}
        muted
        playsInline
        preload={near ? "metadata" : "none"}
        controls={false}
        disablePictureInPicture
        onPlay={(event) => {
          event.currentTarget.pause();
        }}
        onLoadedData={(event) => {
          const video = event.currentTarget;
          if (video.videoWidth > 0) return;
          if (tries.current >= 4) return;
          tries.current += 1;
          window.setTimeout(() => {
            setBust(Date.now());
          }, 2500 * tries.current);
        }}
        onError={() => {
          if (tries.current >= 4) return;
          tries.current += 1;
          window.setTimeout(() => {
            setBust(Date.now());
          }, 2000 * tries.current);
        }}
      />
      <span className="bubble__video-play" aria-hidden>
        <IconPlay size={18} />
      </span>
    </button>
  );
}
