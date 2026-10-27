"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  avatarColor,
  avatarDisplaySrc,
  avatarInitials,
  bareAvatarUrl,
} from "@/lib/avatar";
import { signedMediaSrc } from "@/lib/files";

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
  const latestPhotoSrc = src ? signedMediaSrc(src) : null;
  const photoIdentity = bareAvatarUrl(latestPhotoSrc);
  // Signature refreshes refer to the same photo. Keep the displayed URL until
  // the photo changes or a failed request needs the latest credentials.
  const [photoSrc, setPhotoSrc] = useState(latestPhotoSrc);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedRef = useRef(false);
  failedRef.current = failed;
  const showPhoto = Boolean(photoSrc) && !failed;

  const [prevIdentity, setPrevIdentity] = useState(photoIdentity);
  if (photoIdentity !== prevIdentity || (failed && latestPhotoSrc !== photoSrc)) {
    setPrevIdentity(photoIdentity);
    setPhotoSrc(latestPhotoSrc);
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

  const clearRetry = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  const scheduleRetry = useCallback((nextAttempt: number, delayMs: number) => {
    clearRetry();
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      setAttempt(nextAttempt);
      setLoaded(false);
      setFailed(false);
    }, delayMs);
  }, [clearRetry]);

  const markLoaded = useCallback(() => {
    clearRetry();
    setLoaded(true);
    setFailed(false);
  }, [clearRetry]);

  const handleError = useCallback(() => {
    if (!photoSrc) {
      setFailed(true);
      return;
    }
    if (latestPhotoSrc && latestPhotoSrc !== photoSrc) {
      clearRetry();
      setPhotoSrc(latestPhotoSrc);
      setAttempt(0);
      setLoaded(false);
      setFailed(false);
      return;
    }
    // Cached-image checks and onError can report the same failure. Do not
    // restart its backoff when the parent renders (e.g. speaking updates).
    if (retryTimer.current) return;
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
  }, [photoSrc, latestPhotoSrc, attempt, clearRetry, scheduleRetry]);

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
  }, [photoSrc, clearRetry]);

  /** Cached success/failure may finish before onLoad/onError is attached. */
  const bindImg = useCallback((node: HTMLImageElement | null) => {
    if (!node) return;
    if (!node.complete) return;
    if (node.naturalWidth > 0) markLoaded();
    else handleError();
  }, [markLoaded, handleError]);

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
