"use client";

import { useEffect, useRef, useState } from "react";
import { IconChevronLeft, IconChevronRight, IconExpand } from "@/lib/icons";
import { MediaVideo } from "@/components/chat/MediaVideo";

export type ScreenSource = {
  id: string;
  label: string;
  stream: MediaStream;
};

function ScreenPane({
  source,
  hideBadge = false,
}: {
  source: ScreenSource;
  hideBadge?: boolean;
}) {
  const paneRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      paneRef.current?.requestFullscreen().catch(() => undefined);
    }
  };

  return (
    <div
      ref={paneRef}
      className="call__screen-pane"
      onDoubleClick={toggleFullscreen}
      title="Двойное нажатие — на весь экран"
    >
      <MediaVideo stream={source.stream} className="call__main is-screen" />
      {hideBadge ? null : (
        <em className="call__stage-badge">{source.label}</em>
      )}
      <button
        type="button"
        className="call__screen-fs"
        aria-label={`${source.label} на весь экран`}
        title="Во весь экран"
        onClick={toggleFullscreen}
      >
        <IconExpand size={16} />
      </button>
    </div>
  );
}

function sourceHasLiveVideo(source: ScreenSource) {
  return source.stream
    .getVideoTracks()
    .some((track) => track.readyState === "live");
}

/** Hidden sinks so screen tracks keep decoding while the stage is unmounted. */
export function ScreenShareKeepalive({ sources }: { sources: ScreenSource[] }) {
  const live = sources.filter(sourceHasLiveVideo);
  if (!live.length) return null;
  return (
    <div className="call__screen-keepalive" aria-hidden>
      {live.map((source) => (
        <MediaVideo key={source.id} stream={source.stream} />
      ))}
    </div>
  );
}

export function ScreenShareStage({ sources }: { sources: ScreenSource[] }) {
  const liveSources = sources.filter(sourceHasLiveVideo);
  const [index, setIndex] = useState(0);
  const count = liveSources.length;
  const safeIndex = count === 0 ? 0 : Math.min(index, count - 1);
  const current = liveSources[safeIndex];

  useEffect(() => {
    if (index > 0 && index >= count) setIndex(Math.max(0, count - 1));
  }, [count, index]);

  if (!current) return null;

  const multi = count > 1;

  return (
    <div className="call__screens">
      {multi ? (
        <div
          className="call__screens-switcher"
          role="navigation"
          aria-label="Демонстрации экрана"
        >
          <button
            type="button"
            className="call__screens-arrow"
            aria-label="Предыдущая демонстрация"
            onClick={() => setIndex((value) => (value - 1 + count) % count)}
          >
            <IconChevronLeft size={18} />
          </button>
          <span className="call__screens-label">
            {current.label}
            <em>
              {safeIndex + 1}/{count}
            </em>
          </span>
          <button
            type="button"
            className="call__screens-arrow"
            aria-label="Следующая демонстрация"
            onClick={() => setIndex((value) => (value + 1) % count)}
          >
            <IconChevronRight size={18} />
          </button>
        </div>
      ) : null}
      <ScreenPane source={current} hideBadge={multi} />
    </div>
  );
}
