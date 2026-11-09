"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useMediaIntersection } from "@/hooks/useMediaIntersection";
import { mediaResourceKey, retryMediaSrc, videoPosterSrc } from "@/lib/files";
import { useMediaMicroPreview } from "@/hooks/useMediaMicroPreview";
import { MicroPreviewPlaceholder } from "./MicroPreviewPlaceholder";
import { MediaLoadingIndicator } from "./MediaLoadingIndicator";
import { useMediaDownload } from "@/hooks/useMediaDownload";

type Props = { src: string; className?: string; microPreview?: string };

export function VideoPreview(props: Props) {
  return <PreviewResource key={mediaResourceKey(props.src)} {...props} />;
}

function PreviewResource({ src, className, microPreview }: Props) {
  const { ref, intersecting } = useMediaIntersection<HTMLVideoElement | HTMLImageElement>("800px");
  const [source] = useState(src);
  const poster = videoPosterSrc(source);
  const [posterFailed, setPosterFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const download = useMediaDownload(poster, intersecting && Boolean(poster) && !posterFailed);
  useEffect(() => { if (download.error) setPosterFailed(true); }, [download.error]);
  const placeholderSrc = useMediaMicroPreview(src, microPreview, intersecting && !loaded);
  const placeholder = placeholderSrc && !loaded ? <MicroPreviewPlaceholder source={placeholderSrc} mediaRef={ref} /> : null;
  const indicator = intersecting && !loaded ? <MediaLoadingIndicator progress={download} /> : null;
  const style = !loaded ? { opacity: 0 } : undefined;
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
    <>{placeholder}
    <img ref={ref as RefObject<HTMLImageElement>} className={className} alt="Превью видео"
      style={style} onLoad={() => setLoaded(true)}
      src={download.url} decoding="async"
      onError={() => setPosterFailed(true)} />{indicator}</>
  );

  return <>{placeholder}<video key={attempt} ref={ref as RefObject<HTMLVideoElement>} className={className} style={style}
    src={intersecting ? retryMediaSrc(attempt ? src : source, attempt) : undefined}
    muted playsInline preload={intersecting ? "metadata" : "none"}
    controls={false} disablePictureInPicture
    onPlay={event => event.currentTarget.pause()}
    onLoadedData={event => {
      if (!event.currentTarget.videoWidth) retry();
      else {
        setLoaded(true);
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      }
    }}
    onError={retry} />{indicator}</>;
}
