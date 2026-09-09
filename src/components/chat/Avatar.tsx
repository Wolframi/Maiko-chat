"use client";

import { useEffect, useRef, useState } from "react";
import { avatarColor, avatarInitials } from "@/lib/avatar";

type AvatarProps = {
  name: string;
  src?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  online?: boolean;
};

const MAX_RETRIES = 3;

export function Avatar({
  name,
  src,
  size = "md",
  className = "",
  online,
}: AvatarProps) {
  const label = name || "?";
  // Images no longer need a valid signature to display — strip ?exp&sig noise.
  const photoSrc = src
    ? String(src).split("?")[0].split("#")[0] || null
    : null;
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPhoto = Boolean(photoSrc) && !failed;

  const [prevSrc, setPrevSrc] = useState(photoSrc);
  if (photoSrc !== prevSrc) {
    setPrevSrc(photoSrc);
    setFailed(false);
    setLoaded(false);
    setAttempt(0);
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }

  useEffect(() => {
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  function markLoaded() {
    setLoaded(true);
    setFailed(false);
  }

  function handleError() {
    if (!photoSrc) {
      setFailed(true);
      return;
    }
    if (attempt + 1 >= MAX_RETRIES) {
      setFailed(true);
      setLoaded(false);
      return;
    }
    const next = attempt + 1;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      setAttempt(next);
      setLoaded(false);
      setFailed(false);
    }, 400 * next);
  }

  /** Cached images may finish before onLoad is attached. */
  function bindImg(node: HTMLImageElement | null) {
    if (!node) return;
    if (node.complete && node.naturalWidth > 0) {
      markLoaded();
    }
  }

  return (
    <span
      className={`avatar avatar--${size} ${showPhoto ? "avatar--photo" : ""} ${
        online ? "avatar--online" : ""
      } ${className}`.trim()}
      style={showPhoto && loaded ? undefined : { background: avatarColor(label) }}
      aria-hidden
    >
      {showPhoto ? (
        <>
          {!loaded && (
            <span className="avatar__fallback">{avatarInitials(label)}</span>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={`${photoSrc}::${attempt}`}
            ref={bindImg}
            src={photoSrc || ""}
            alt=""
            decoding="async"
            loading="eager"
            referrerPolicy="no-referrer"
            draggable={false}
            className={loaded ? "is-loaded" : ""}
            onLoad={markLoaded}
            onError={handleError}
          />
        </>
      ) : (
        avatarInitials(label)
      )}
    </span>
  );
}
