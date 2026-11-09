"use client";

import { useCallback, useEffect, useRef, useState, type ImgHTMLAttributes, type KeyboardEvent, type MouseEvent } from "react";
import { useMediaIntersection } from "@/hooks/useMediaIntersection";
import { mediaResourceKey, retryMediaSrc, withoutThumbParam } from "@/lib/files";
import { IconImage } from "@/lib/icons";
import { useMediaMicroPreview } from "@/hooks/useMediaMicroPreview";
import { MicroPreviewPlaceholder } from "./MicroPreviewPlaceholder";
import { MediaLoadingIndicator } from "./MediaLoadingIndicator";
import { useMediaDownload } from "@/hooks/useMediaDownload";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  src: string; microPreview?: string; resolveMicroPreview?: boolean; sticker?: boolean;
};

export function ChatImage(props: Props) {
  return <ImageResource key={mediaResourceKey(props.src)} {...props} />;
}

function ImageResource({ src, alt = "", loading = "lazy", microPreview, resolveMicroPreview = false, sticker = false, onLoad, style, ...props }: Props) {
  const { ref, intersecting } = useMediaIntersection<HTMLImageElement>("800px");
  const visible = useMediaIntersection<HTMLImageElement>("0px", false, ref);
  // A refreshed signature must not download an already displayed photo again.
  const [source, setSource] = useState(src);
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const requested = intersecting || loading === "eager";
  const placeholderSrc = useMediaMicroPreview(src, microPreview, resolveMicroPreview && requested && !loaded && !broken);
  const latest = useRef(src);
  latest.current = src;
  const download = useMediaDownload(retryMediaSrc(source, attempt), requested && !broken);
  const handleError = useCallback(() => {
    setLoaded(false);
    const original = withoutThumbParam(source);
    if (original !== source) { setSource(original); return; }
    if (attempt < 1) {
      setSource(withoutThumbParam(latest.current));
      setAttempt(1);
    } else setBroken(true);
  }, [attempt, source]);
  useEffect(() => { if (download.error) handleError(); }, [download.error, handleError]);

  const retry = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSource(withoutThumbParam(latest.current));
    setAttempt(value => value + 1);
    setLoaded(false);
    setBroken(false);
  };

  if (broken) return (
    <span role="button" tabIndex={0} className="bubble__media-retry" aria-label="Повторить загрузку"
      onClick={retry} onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") retry(event);
      }}>
      <IconImage size={22} /><span>Не удалось загрузить</span>
    </span>
  );

  return (
    <>
    {placeholderSrc && !loaded ? <MicroPreviewPlaceholder source={placeholderSrc} mediaRef={ref} /> : null}
    <img {...props} ref={ref} src={download.url}
      style={{ ...style, ...(!loaded ? { opacity: 0 } : {}) }}
      alt={alt} loading="eager" decoding="async" referrerPolicy="no-referrer"
      fetchPriority={props.fetchPriority ?? (visible.intersecting ? "high" : "low")}
      onLoad={event => { setLoaded(true); onLoad?.(event); }}
      onError={handleError} />
    {!loaded && requested ? <MediaLoadingIndicator sticker={sticker} progress={download} /> : null}
    </>
  );
}
