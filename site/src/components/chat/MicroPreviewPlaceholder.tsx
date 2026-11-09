"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

/** Match the crop/letterboxing of the media that will replace this preview. */
export function MicroPreviewPlaceholder({ source, mediaRef }: {
  source: string;
  mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>;
}) {
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    if (!ref.current || !mediaRef.current) return;
    const style = getComputedStyle(mediaRef.current);
    ref.current.style.objectFit = style.objectFit;
    ref.current.style.objectPosition = style.objectPosition;
  });
  return <img ref={ref} src={source} alt="" aria-hidden="true"
    className="media-micro-preview" decoding="async"
    style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
      pointerEvents: "none", borderRadius: "inherit" }} />;
}
