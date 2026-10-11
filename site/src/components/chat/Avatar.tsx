"use client";

import { useEffect, useRef, useState } from "react";
import {
  avatarColor,
  avatarDisplaySrc,
  avatarInitials,
  bareAvatarUrl,
} from "@/lib/avatar";

type AvatarProps = {
  name: string;
  src?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  online?: boolean;
};

const FAST_RETRIES = 5;
const SLOW_RETRIES = 6;

export function Avatar({
  name,
  src,
  size = "md",
  className = "",
  online,
}: AvatarProps) {
  const label = name || "?";
  const photoSrc = bareAvatarUrl(src);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedRef = useRef(false);
  failedRef.current = failed;
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

  function clearRetry() {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }

  function scheduleRetry(nextAttempt: number, delayMs: number) {
    clearRetry();
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      setAttempt(nextAttempt);
      setLoaded(false);
      setFailed(false);
    }, delayMs);
  }

  function markLoaded() {
    clearRetry();
    setLoaded(true);
    setFailed(false);
  }

  function handleError() {
    if (!photoSrc) {
      setFailed(true);
      return;
    }
    const next = attempt + 1;
    if (next <= FAST_RETRIES) {
      scheduleRetry(next, Math.min(2500, 280 * next));
      return;
    }
    if (next <= FAST_RETRIES + SLOW_RETRIES) {
      setFailed(true);
      setLoaded(false);
      scheduleRetry(next, Math.min(20_000, 3000 * (next - FAST_RETRIES)));
      return;
    }
    setFailed(true);
    setLoaded(false);
  }

  useEffect(() => {
    if (!photoSrc) return;
    function revive() {
      if (document.hidden || !failedRef.current) return;
      clearRetry();
      setFailed(false);
      setLoaded(false);
      setAttempt((n) => n + 1);
    }
    document.addEventListener("visibilitychange", revive);
    window.addEventListener("focus", revive);
    window.addEventListener("online", revive);
    return () => {
      document.removeEventListener("visibilitychange", revive);
      window.removeEventListener("focus", revive);
      window.removeEventListener("online", revive);
    };
  }, [photoSrc]);

  /** Cached success/failure may finish before onLoad/onError is attached. */
  function bindImg(node: HTMLImageElement | null) {
    if (!node) return;
    if (!node.complete) return;
    if (node.naturalWidth > 0) markLoaded();
    else handleError();
  }

  const imgSrc = photoSrc ? avatarDisplaySrc(photoSrc, attempt) : "";

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
            src={imgSrc}
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
