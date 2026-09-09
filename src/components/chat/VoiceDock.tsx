"use client";

import {
  IconExpand,
  IconHeadphones,
  IconMic,
  IconMicOff,
  IconPhoneOff,
  IconVolume,
} from "@/lib/icons";

type VoiceDockProps = {
  channelTitle: string;
  groupTitle?: string;
  muted: boolean;
  deafened: boolean;
  peerCount: number;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onLeave: () => void;
  onExpand?: () => void;
};

export function VoiceDock({
  channelTitle,
  groupTitle,
  muted,
  deafened,
  peerCount,
  onToggleMute,
  onToggleDeafen,
  onLeave,
  onExpand,
}: VoiceDockProps) {
  return (
    <div className="voice-dock" role="status" aria-live="polite">
      <div className="voice-dock__meta">
        <IconVolume size={16} />
        <div>
          <strong>Голос · {channelTitle}</strong>
          <span>
            {groupTitle ? `${groupTitle} · ` : ""}
            {peerCount === 0
              ? "только вы"
              : `ещё ${peerCount}`}
          </span>
        </div>
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
