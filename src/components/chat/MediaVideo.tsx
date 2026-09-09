"use client";

import {
  forwardRef,
  useEffect,
  useRef,
  type VideoHTMLAttributes,
} from "react";

type MediaVideoProps = Omit<
  VideoHTMLAttributes<HTMLVideoElement>,
  "src" | "ref"
> & {
  stream: MediaStream | null;
  active?: boolean;
};

function videoTrackKey(stream: MediaStream | null) {
  if (!stream) return "";
  return stream
    .getVideoTracks()
    .map(
      (track) =>
        `${track.id}:${track.readyState}:${track.muted}:${track.enabled}`,
    )
    .join("|");
}

export const MediaVideo = forwardRef<HTMLVideoElement, MediaVideoProps>(
  function MediaVideo(
    { stream, active = true, className, muted = true, ...props },
    forwardedRef,
  ) {
    const videoRef = useRef<HTMLVideoElement | null>(null);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;
      const nextStream = active ? stream : null;
      let boundKey = "";
      const startedAt = performance.now();
      let binding = false;

      const bind = (force = false) => {
        const key = videoTrackKey(nextStream);
        if (!force && video.srcObject === nextStream && key === boundKey) {
          video.muted = muted;
          return;
        }
        binding = true;
        if (nextStream) {
          if (video.srcObject === nextStream) video.srcObject = null;
          video.srcObject = nextStream;
        } else {
          video.srcObject = null;
        }
        boundKey = key;
        video.muted = muted;
        binding = false;
      };

      const play = () => {
        if (!active || !video.srcObject) return;
        if (document.visibilityState === "hidden") return;
        void video.play().catch(() => undefined);
      };

      const recoverIfBlack = () => {
        if (binding || !nextStream || !active) return;
        if (performance.now() - startedAt < 1600) return;
        if (video.readyState < 2 || video.videoWidth > 0) return;
        const live = nextStream
          .getVideoTracks()
          .some(
            (track) =>
              track.readyState === "live" && track.enabled && !track.muted,
          );
        if (!live) return;
        bind(true);
        play();
      };

      const onTrackChange = () => {
        bind(true);
        play();
      };

      bind(true);
      play();

      const retryTimers: number[] = [];
      video.addEventListener("loadedmetadata", play);
      video.addEventListener("canplay", play);
      document.addEventListener("visibilitychange", play);
      window.addEventListener("online", play);
      nextStream?.addEventListener("addtrack", onTrackChange);
      nextStream?.addEventListener("removetrack", onTrackChange);
      for (const track of nextStream?.getVideoTracks() ?? []) {
        track.addEventListener("unmute", onTrackChange);
        track.addEventListener("ended", onTrackChange);
      }
      for (const delay of [0, 250, 900, 1800]) {
        retryTimers.push(window.setTimeout(play, delay));
      }
      const poll = window.setInterval(recoverIfBlack, 900);

      return () => {
        window.clearInterval(poll);
        for (const timer of retryTimers) window.clearTimeout(timer);
        video.removeEventListener("loadedmetadata", play);
        video.removeEventListener("canplay", play);
        document.removeEventListener("visibilitychange", play);
        window.removeEventListener("online", play);
        nextStream?.removeEventListener("addtrack", onTrackChange);
        nextStream?.removeEventListener("removetrack", onTrackChange);
        for (const track of nextStream?.getVideoTracks() ?? []) {
          track.removeEventListener("unmute", onTrackChange);
          track.removeEventListener("ended", onTrackChange);
        }
      };
    }, [active, muted, stream]);

    return (
      <video
        {...props}
        ref={(node) => {
          videoRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        className={className}
        autoPlay
        playsInline
        muted={muted}
      />
    );
  },
);
