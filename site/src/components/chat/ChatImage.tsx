"use client";

import { useRef, useState, type ImgHTMLAttributes, type KeyboardEvent, type MouseEvent } from "react";
import { useMediaIntersection } from "@/hooks/useMediaIntersection";
import { mediaResourceKey, retryMediaSrc, withoutThumbParam } from "@/lib/files";
import { IconImage } from "@/lib/icons";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & { src: string };

export function ChatImage(props: Props) {
  return <ImageResource key={mediaResourceKey(props.src)} {...props} />;
}

function ImageResource({ src, alt = "", loading = "lazy", ...props }: Props) {
  const { ref, intersecting } = useMediaIntersection<HTMLImageElement>("800px");
  const visible = useMediaIntersection<HTMLImageElement>("0px", false, ref);
  // A refreshed signature must not download an already displayed photo again.
  const [source, setSource] = useState(src);
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);
  const latest = useRef(src);
  latest.current = src;

  const retry = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSource(withoutThumbParam(latest.current));
    setAttempt(value => value + 1);
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
    <img {...props} ref={ref} src={intersecting || loading === "eager" ? retryMediaSrc(source, attempt) : undefined}
      alt={alt} loading="eager" decoding="async" referrerPolicy="no-referrer"
      fetchPriority={props.fetchPriority ?? (visible.intersecting ? "high" : "low")}
      onError={() => {
        const original = withoutThumbParam(source);
        if (original !== source) { setSource(original); return; }
        if (attempt < 1) {
          setSource(withoutThumbParam(latest.current));
          setAttempt(1);
        } else setBroken(true);
      }} />
  );
}
