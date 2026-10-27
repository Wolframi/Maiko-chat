import type { CSSProperties } from "react";
import { fitGifDisplaySize, parseMediaSize } from "./files";

/** Keep the preview frame independent of downloaded pixels and metadata. */
export function mediaFrameStyle(
  file: { width?: number; height?: number },
  gif = false,
): CSSProperties {
  // Legacy attachments without dimensions keep this frame after loading, too.
  const size = parseMediaSize(file) ?? { width: 320, height: 240 };
  const ratio = size.width / size.height;
  const box = gif ? fitGifDisplaySize(size.width, size.height) : size;
  return {
    width: gif
      ? box.width
      : `min(${Math.min(size.width, 430)}px, ${48 * ratio}dvh, calc(var(--bubble-media-max-height, 430px) * ${ratio}))`,
    maxWidth: "100%",
    aspectRatio: `${box.width} / ${box.height}`,
  };
}
