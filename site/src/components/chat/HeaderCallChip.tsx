"use client";

import { IconMic, IconMicOff, IconPhoneOff, IconVolume } from "@/lib/icons";
import { Avatar } from "@/components/chat/Avatar";

type HeaderCallChipProps = {
  title: string;
  subtitle: string;
  avatarUrl?: string | null;
  mark: "call" | "voice";
  speaking?: boolean;
  muted: boolean;
  onOpen: () => void;
  onToggleMute: () => void;
  onEnd: () => void;
};

export function HeaderCallChip({
  title,
  subtitle,
  avatarUrl = null,
  mark,
  speaking = false,
  muted,
  onOpen,
  onToggleMute,
  onEnd,
}: HeaderCallChipProps) {
  const openLabel =
    mark === "voice" ? `Вернуться в канал ${title}` : `Вернуться к звонку с ${title}`;
  const endLabel = mark === "voice" ? "Отключиться" : "Завершить звонок";

  return (
    <div className="header-call" role="region" aria-label={openLabel}>
      <button
        type="button"
        className="header-call__open"
        onClick={onOpen}
        title="Вернуться к звонку"
        aria-label={openLabel}
      >
        <span className="header-call__live" aria-hidden />
        <span className={`header-call__avatar ${speaking ? "is-speaking" : ""}`}>
          {mark === "voice" && !avatarUrl ? (
            <IconVolume size={16} />
          ) : (
            <Avatar name={title} src={avatarUrl} size="sm" />
          )}
        </span>
        <span className="header-call__text">
          <strong>{title}</strong>
          <em>{subtitle}</em>
        </span>
      </button>
      <button
        type="button"
        className={`header-call__btn ${muted ? "is-off" : ""}`}
        onClick={onToggleMute}
        aria-label={muted ? "Включить микрофон" : "Выключить микрофон"}
        title={muted ? "Включить микрофон" : "Выключить микрофон"}
      >
        {muted ? <IconMicOff size={16} /> : <IconMic size={16} />}
      </button>
      <button
        type="button"
        className="header-call__btn header-call__end"
        onClick={onEnd}
        aria-label={endLabel}
        title={endLabel}
      >
        <IconPhoneOff size={16} />
      </button>
    </div>
  );
}
