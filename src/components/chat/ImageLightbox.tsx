"use client";

import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Download from "yet-another-react-lightbox/plugins/download";
import Video from "yet-another-react-lightbox/plugins/video";
import "yet-another-react-lightbox/styles.css";

export type MediaLightboxItem = {
  src: string;
  name?: string;
  kind?: "image" | "video";
};

type MediaLightboxProps = {
  item: MediaLightboxItem | null;
  onClose: () => void;
};

export function MediaLightbox({ item, onClose }: MediaLightboxProps) {
  const open = Boolean(item?.src);
  const title = item?.kind === "video" ? "Видео" : "Фото";
  const src = item?.src || "";
  const downloadUrl = src
    ? `${src}${src.includes("?") ? "&" : "?"}download=1`
    : "";
  const isVideo = item?.kind === "video";
  const downloadName = isVideo
    ? item?.name && /\.(mp4|webm|mov|m4v)$/i.test(item.name)
      ? item.name
      : "video.mp4"
    : item?.name && /\.(png|jpe?g|gif|webp)$/i.test(item.name)
      ? item.name
      : "photo.jpg";

  return (
    <Lightbox
      open={open}
      close={onClose}
      slides={
        src
          ? [
              isVideo
                ? {
                    type: "video" as const,
                    width: 1280,
                    height: 720,
                    sources: [
                      {
                        src,
                        type: guessVideoMime(item?.name || src),
                      },
                    ],
                    download: {
                      url: downloadUrl,
                      filename: downloadName,
                    },
                  }
                : {
                    src,
                    alt: title,
                    download: {
                      url: downloadUrl,
                      filename: downloadName,
                    },
                  },
            ]
          : []
      }
      plugins={isVideo ? [Video, Download] : [Zoom, Download]}
      animation={{ fade: 280 }}
      controller={{ closeOnBackdropClick: true }}
      video={{
        controls: true,
        playsInline: true,
        autoPlay: true,
        preload: "metadata",
      }}
      styles={{
        container: {
          backgroundColor: "rgba(20, 28, 24, 0.72)",
          backdropFilter: "blur(6px)",
        },
        navigationPrev: { display: "none" },
        navigationNext: { display: "none" },
      }}
      render={{
        buttonPrev: () => null,
        buttonNext: () => null,
      }}
      labels={{
        Close: "Закрыть",
        Download: "Скачать",
        "Zoom in": "Приблизить",
        "Zoom out": "Отдалить",
      }}
    />
  );
}

function guessVideoMime(nameOrUrl: string) {
  const lower = nameOrUrl.toLowerCase();
  if (lower.includes(".webm")) return "video/webm";
  if (lower.includes(".mov")) return "video/quicktime";
  if (lower.includes(".mkv")) return "video/x-matroska";
  return "video/mp4";
}

/** @deprecated use MediaLightbox */
export function ImageLightbox({
  src,
  name,
  onClose,
}: {
  src: string | null;
  name?: string;
  onClose: () => void;
}) {
  return (
    <MediaLightbox
      item={src ? { src, name, kind: "image" } : null}
      onClose={onClose}
    />
  );
}
