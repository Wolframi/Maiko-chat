"use client";

import {
  IconExpand,
  IconHeadphones,
  IconMic,
  IconMicOff,
  IconPhoneOff,
} from "@/lib/icons";

import { ConnectionSignal, type SignalQuality } from "@/components/chat/ConnectionSignal";

type VoiceDockProps = {
  title: string;
  connectionLabel?: string | null;
  connectionQuality?: SignalQuality;
  rttMs?: number | null;
  muted: boolean;
  deafened: boolean;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onLeave: () => void;
  onExpand?: () => void;
};

export function VoiceDock({
  title,
  connectionLabel = null,
  connectionQuality = "unknown",
  rttMs = null,
  muted,
  deafened,
  onToggleMute,
  onToggleDeafen,
  onLeave,
  onExpand,
}: VoiceDockProps) {
  return (
    <div className="voice-dock" role="status" aria-live="polite">
      <div className="voice-dock__meta">
        <strong title={title}>{title}</strong>
        <ConnectionSignal quality={connectionQuality} rttMs={rttMs} pending={connectionLabel} />
      </div>
      <div className="voice-dock__actions">
        {onExpand ? (
          <button
            type="button"
            className="voice-dock__btn"
            aria-label="Развернуть голосовой канал"
            title="Развернуть"
            onClick={onExpand}
          >
            <IconExpand size={18} />
          </button>
        ) : null}
        <button
          type="button"
          className={`voice-dock__btn ${muted ? "is-off" : ""}`}
          aria-label={muted ? "Включить микрофон" : "Выключить микрофон"}
          title={muted ? "Включить микрофон" : "Выключить микрофон"}
          onClick={onToggleMute}
        >
          {muted ? <IconMicOff size={18} /> : <IconMic size={18} />}
        </button>
        <button
          type="button"
          className={`voice-dock__btn ${deafened ? "is-off" : ""}`}
          aria-label={deafened ? "Включить звук" : "Отключить звук"}
          title={deafened ? "Включить звук" : "Отключить звук"}
          onClick={onToggleDeafen}
        >
          <IconHeadphones size={18} />
        </button>
        <button
          type="button"
          className="voice-dock__btn voice-dock__btn--leave"
          aria-label="Выйти из голосового канала"
          title="Отключиться"
          onClick={onLeave}
        >
          <IconPhoneOff size={18} />
        </button>
      </div>
    </div>
  );
}
