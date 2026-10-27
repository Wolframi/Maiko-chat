"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { IconVolume, IconVolumeOff } from "@/lib/icons";
import { MediaVideo } from "@/components/chat/MediaVideo";
import { ScreenAudioVisualizer } from "@/components/chat/ScreenAudioVisualizer";
import { useCallTileInteraction } from "@/hooks/useCallTileInteraction";
import { useCallTileLayout } from "@/hooks/useCallTileLayout";
import {
  getScreenAudioVolume,
  setScreenAudioVolume,
  subscribeScreenAudioVolume,
} from "@/lib/screenAudio";

export type ScreenSource = {
  id: string;
  label: string;
  stream: MediaStream;
  audioStream?: MediaStream | null;
  kind?: "screen" | "camera";
  ownerId?: string;
  /** Своя демонстрация — её звук локально не играет, ручка не нужна. */
  local?: boolean;
};

export function ScreenInlineVolume({
  owner,
  label,
}: {
  owner: string;
  label: string;
}) {
  const volume = useSyncExternalStore(
    subscribeScreenAudioVolume,
    () => getScreenAudioVolume(owner),
    () => 1,
  );
  const lastVolumeRef = useRef(volume || 1);
  const percent = Math.round(volume * 100);
  const muted = volume <= 0;

  const apply = (value: number) => {
    const next = Math.min(1, Math.max(0, Number(value.toFixed(2))));
    if (next > 0) lastVolumeRef.current = next;
    setScreenAudioVolume(next, owner);
  };

  return (
    <div
      className="screen-vol-inline"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={muted ? `Включить звук ${label}` : `Выключить звук ${label}`}
        title={muted ? "Включить звук" : "Выключить звук"}
        onClick={() => apply(muted ? lastVolumeRef.current : 0)}
      >
        {muted ? <IconVolumeOff size={15} /> : <IconVolume size={15} />}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label={`Громкость ${label}`}
        onChange={(event) => apply(Number(event.currentTarget.value) / 100)}
      />
      <output>{percent}</output>
    </div>
  );
}

function ScreenPane({
  source,
  onSwap,
}: {
  source: ScreenSource;
  onSwap?: (fromId: string, toId: string) => void;
}) {
  const interaction = useCallTileInteraction({ id: source.id, onSwap });

  return (
    <div
      className="call__screen-pane is-interactive"
      role="button"
      tabIndex={0}
      aria-label={`Открыть ${source.label}`}
      title={onSwap ? "Нажатие — на весь экран; перетаскивание или Alt + стрелка — поменять местами" : "Нажатие — на весь экран"}
      {...interaction}
    >
      <div className="call__screen-media">
        <MediaVideo
          stream={source.stream}
          className={`call__main ${
            source.kind === "camera" ? "is-camera" : "is-screen"
          }`}
        />
      </div>
      {source.kind !== "camera" ? (
        <ScreenAudioVisualizer stream={source.audioStream ?? source.stream} />
      ) : null}
      {source.kind !== "camera" && !source.local ? (
        <footer
          className="call__screen-controls"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <strong title={source.label}>{source.label}</strong>
          <ScreenInlineVolume
            owner={source.ownerId ?? source.id}
            label={source.label}
          />
        </footer>
      ) : null}
    </div>
  );
}

function sourceHasLiveVideo(source: ScreenSource) {
  return source.stream
    .getVideoTracks()
    .some((track) => track.readyState === "live");
}

/** Ручка громкости демонстрации — своя на каждую демонстрацию. */
export function ScreenVolumeKnob({
  owner,
  label,
}: {
  owner?: string;
  label?: string;
}) {
  const volume = useSyncExternalStore(
    subscribeScreenAudioVolume,
    () => getScreenAudioVolume(owner),
    () => 1,
  );
  const [open, setOpen] = useState(false);
  const dragRef = useRef(false);
  const leaveTimerRef = useRef<number | null>(null);
  const lastVolumeRef = useRef(volume || 1);

  useEffect(() => {
    lastVolumeRef.current = getScreenAudioVolume(owner) || 1;
  }, [owner]);

  const apply = useCallback(
    (value: number) => {
      const next = Math.min(1, Math.max(0, Number(value.toFixed(2))));
      setScreenAudioVolume(next, owner);
    },
    [owner],
  );

  const seekFromClientY = useCallback(
    (clientY: number, target: HTMLElement) => {
      const rect = target.getBoundingClientRect();
      const ratio = 1 - (clientY - rect.top) / Math.max(1, rect.height);
      apply(ratio);
    },
    [apply],
  );

  const muted = volume <= 0;
  const percent = Math.round(volume * 100);
  const name = label ? ` демонстрации «${label}»` : " демонстрации";

  return (
    <div
      className={`screen-vol ${open ? "is-open" : ""}`}
      onPointerEnter={() => {
        if (leaveTimerRef.current) window.clearTimeout(leaveTimerRef.current);
        setOpen(true);
      }}
      onPointerLeave={() => {
        if (dragRef.current) return;
        leaveTimerRef.current = window.setTimeout(() => setOpen(false), 140);
      }}
    >
      <button
        type="button"
        className={`call__btn call__btn--circle ${muted ? "is-off" : ""}`}
        aria-label={`Громкость${name}`}
        title={`Громкость${name}`}
        onClick={() => {
          if (muted) {
            apply(lastVolumeRef.current > 0 ? lastVolumeRef.current : 1);
          } else {
            lastVolumeRef.current = volume;
            apply(0);
          }
        }}
      >
        {muted ? <IconVolumeOff size={20} /> : <IconVolume size={20} />}
      </button>
      <div className="screen-vol__pop">
        <span>{percent}</span>
        <div
          className="screen-vol__track"
          role="slider"
          aria-label={`Громкость${name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-orientation="vertical"
          onPointerDown={(event) => {
            dragRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            seekFromClientY(event.clientY, event.currentTarget);
          }}
          onPointerMove={(event) => {
            if (!dragRef.current) return;
            seekFromClientY(event.clientY, event.currentTarget);
          }}
          onPointerUp={() => {
            dragRef.current = false;
          }}
          onPointerCancel={() => {
            dragRef.current = false;
          }}
        >
          <i style={{ height: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
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

export function ScreenShareStage({
  sources,
  onCurrentChange,
  onSwap,
}: {
  sources: ScreenSource[];
  /** Какая демонстрация сейчас на экране — для ручки громкости в панели. */
  onCurrentChange?: (id: string | null) => void;
  /** Shared layout when camera tiles can also be moved into the stage. */
  onSwap?: (fromId: string, toId: string) => void;
}) {
  const liveSources = sources.filter(sourceHasLiveVideo);
  const count = liveSources.length;
  const { ordered, swap } = useCallTileLayout(liveSources);
  const orderedSources = onSwap ? liveSources : ordered;
  const current = orderedSources[0];
  const currentId = current?.id ?? null;

  useEffect(() => {
    onCurrentChange?.(currentId);
  }, [currentId, onCurrentChange]);
  useEffect(() => () => onCurrentChange?.(null), [onCurrentChange]);

  if (!current) return null;

  const multi = count > 1;
  const layoutCount = Math.min(count, 5);

  return (
    <div
      className={`call__screens call__screens--count-${layoutCount} ${
        multi ? "is-multi" : ""
      }`}
      data-screen-count={count}
      aria-label={
        count === 1 ? "Видео звонка" : `${count} видео звонка`
      }
    >
      {orderedSources.map((source) => (
        <ScreenPane
          key={source.id}
          source={source}
          onSwap={onSwap ?? (multi ? swap : undefined)}
        />
      ))}
    </div>
  );
}
