"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { IconVolume, IconVolumeOff } from "@/lib/icons";
import { MediaVideo } from "@/components/chat/MediaVideo";
import {
  getScreenAudioVolume,
  setScreenAudioVolume,
  subscribeScreenAudioVolume,
} from "@/lib/screenAudio";

export type ScreenSource = {
  id: string;
  label: string;
  stream: MediaStream;
  kind?: "screen" | "camera";
  ownerId?: string;
  /** Своя демонстрация — её звук локально не играет, ручка не нужна. */
  local?: boolean;
};

function ScreenInlineVolume({
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
  selected = false,
  selectable = false,
  onSelect,
}: {
  source: ScreenSource;
  selected?: boolean;
  selectable?: boolean;
  onSelect?: () => void;
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
      className={`call__screen-pane ${selected ? "is-selected" : ""} ${
        selectable ? "is-selectable" : ""
      }`}
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-label={selectable ? `Выбрать ${source.label}` : undefined}
      aria-pressed={selectable ? selected : undefined}
      onClick={selectable ? onSelect : undefined}
      onKeyDown={
        selectable
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelect?.();
            }
          : undefined
      }
      onDoubleClick={toggleFullscreen}
      title="Двойное нажатие — на весь экран"
    >
      <div className="call__screen-media">
        <MediaVideo
          stream={source.stream}
          className={`call__main ${
            source.kind === "camera" ? "is-camera" : "is-screen"
          }`}
        />
        {selectable && selected ? (
          <em className="call__stage-badge"><span>Основной</span></em>
        ) : null}
      </div>
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
}: {
  sources: ScreenSource[];
  /** Какая демонстрация сейчас на экране — для ручки громкости в панели. */
  onCurrentChange?: (id: string | null) => void;
}) {
  const liveSources = sources.filter(sourceHasLiveVideo);
  const count = liveSources.length;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current =
    liveSources.find((source) => source.id === selectedId) ?? liveSources[0];
  const currentId = current?.id ?? null;

  const orderedSources = useMemo(() => {
    if (!current || liveSources[0]?.id === current.id) return liveSources;
    return [
      current,
      ...liveSources.filter((source) => source.id !== current.id),
    ];
  }, [current, liveSources]);

  useEffect(() => {
    if (!count) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !liveSources.some((source) => source.id === selectedId)) {
      setSelectedId(liveSources[0].id);
    }
  }, [count, liveSources, selectedId]);

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
        count === 1 ? "Основное видео звонка" : `${count} видео на основной сцене`
      }
    >
      {orderedSources.map((source) => (
        <ScreenPane
          key={source.id}
          source={source}
          selected={source.id === current.id}
          selectable={multi}
          onSelect={() => setSelectedId(source.id)}
        />
      ))}
    </div>
  );
}
