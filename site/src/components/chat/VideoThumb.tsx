"use client";

import { mediaSrc, signedMediaSrc } from "@/lib/files";
import { IconPlay } from "@/lib/icons";
import { mediaFrameStyle } from "@/lib/mediaLayout";
import { VideoPreview } from "@/components/chat/VideoPreview";

type VideoThumbProps = {
  url: string;
  width?: number;
  height?: number;
  onOpen?: () => void;
};

/** Inline chat video preview, loaded as it approaches the viewport. */
export function VideoThumb({ url, width, height, onOpen }: VideoThumbProps) {
  const base = signedMediaSrc(url) || mediaSrc(url);

  return (
    <button
      type="button"
      className="bubble__video-btn bubble__media-frame"
      style={mediaFrameStyle({ width, height })}
      onClick={onOpen}
      aria-label="Открыть видео"
    >
      <VideoPreview src={base} className="bubble__video" />
      <span className="bubble__video-play" aria-hidden>
        <IconPlay size={18} />
      </span>
    </button>
  );
}
