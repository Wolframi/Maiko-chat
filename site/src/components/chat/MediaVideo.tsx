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

function videoTracks(stream: MediaStream | null) {
  return stream?.getVideoTracks() ?? [];
}

function sameVideoTracks(a: MediaStream | null, b: MediaStream | null) {
  const left = videoTracks(a);
  const right = videoTracks(b);
  return (
    left.length > 0 &&
    left.length === right.length &&
    left.every((track, index) => track === right[index])
  );
}

function liveVideo(stream: MediaStream | null) {
  return videoTracks(stream).some((track) => track.readyState === "live");
}

export const MediaVideo = forwardRef<HTMLVideoElement, MediaVideoProps>(
  function MediaVideo(
    { stream, active = true, className, muted = true, ...props },
    forwardedRef,
  ) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const heldRef = useRef<MediaStream | null>(null);
    const incoming = active ? stream : null;
    if (incoming && liveVideo(incoming)) heldRef.current = incoming;
    else if (!liveVideo(heldRef.current)) heldRef.current = null;
    const shown = (incoming && liveVideo(incoming) ? incoming : null) ?? heldRef.current;

    useEffect(() => {
      const video = videoRef.current;
      if (video) video.muted = muted;
    }, [muted]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;
      const nextStream = shown;
      const startedAt = performance.now();

      const bind = () => {
        const current = video.srcObject instanceof MediaStream ? video.srcObject : null;
        if (sameVideoTracks(current, nextStream)) return;
        video.srcObject = nextStream;
      };

      const play = () => {
        if (!video.srcObject) return;
        if (document.visibilityState === "hidden") return;
        void video.play().catch(() => undefined);
      };

      const recoverIfBlack = () => {
        if (!nextStream) return;
        if (performance.now() - startedAt < 1600) return;
        if (video.videoWidth > 0) return;
        const live = videoTracks(nextStream).some(
          (track) => track.readyState === "live" && track.enabled && !track.muted,
        );
        if (!live) return;
        bind();
        play();
      };

      const onTrackChange = () => {
        bind();
        play();
      };

      bind();
      play();

      const retryTimers: number[] = [];
      video.addEventListener("loadedmetadata", play);
      video.addEventListener("canplay", play);
      document.addEventListener("visibilitychange", play);
      window.addEventListener("online", play);
      nextStream?.addEventListener("addtrack", onTrackChange);
      nextStream?.addEventListener("removetrack", onTrackChange);
      for (const track of videoTracks(nextStream)) {
        track.addEventListener("unmute", onTrackChange);
        track.addEventListener("ended", onTrackChange);
      }
      for (const delay of [0, 250, 900]) {
        retryTimers.push(window.setTimeout(play, delay));
      }
      const poll = window.setInterval(recoverIfBlack, 1200);

      return () => {
        window.clearInterval(poll);
        for (const timer of retryTimers) window.clearTimeout(timer);
        video.removeEventListener("loadedmetadata", play);
        video.removeEventListener("canplay", play);
        document.removeEventListener("visibilitychange", play);
        window.removeEventListener("online", play);
        nextStream?.removeEventListener("addtrack", onTrackChange);
        nextStream?.removeEventListener("removetrack", onTrackChange);
        for (const track of videoTracks(nextStream)) {
          track.removeEventListener("unmute", onTrackChange);
          track.removeEventListener("ended", onTrackChange);
        }
      };
    }, [shown]);

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
