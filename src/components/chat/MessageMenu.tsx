"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconCopy,
  IconEdit,
  IconDownload,
  IconForward,
  IconReply,
  IconTrash,
} from "@/lib/icons";
import { ReactionPicker } from "@/components/chat/ReactionPicker";

type MessageMenuProps = {
  open: boolean;
  anchorRef?: React.RefObject<HTMLElement | null>;
  anchorEl?: HTMLElement | null;
  mine: boolean;
  canCopy: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canForward: boolean;
  canRetry: boolean;
  canDiscard: boolean;
  canDownload: boolean;
  onClose: () => void;
  onReply: () => void;
  onCopy: () => void;
  onReact: (emoji: string) => void;
  onEdit?: () => void;
  onForward?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  onDownload?: () => void;
};

export function MessageMenu({
  open,
  anchorRef,
  anchorEl,
  mine,
  canCopy,
  canDelete,
  canEdit,
  canForward,
  canRetry,
  canDiscard,
  canDownload,
  onClose,
  onReply,
  onCopy,
  onReact,
  onEdit,
  onForward,
  onDelete,
  onRetry,
  onDiscard,
  onDownload,
}: MessageMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = anchorRef ? anchorRef.current : anchorEl;
    if (!open || !el) {
      if (pos !== null) setPos(null);
      return;
    }

    function place() {
      const el = anchorRef ? anchorRef.current : anchorEl;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const menu = rootRef.current;
      const width = menu?.offsetWidth || 220;
      const height = menu?.offsetHeight || 320;
      let left = mine ? rect.right - width : rect.left;
      let top = rect.top - 8 - Math.min(height, 360);
      left = Math.min(Math.max(10, left), window.innerWidth - width - 10);
      if (top < 10) top = Math.min(rect.bottom + 8, window.innerHeight - height - 10);
      setPos({ top, left });
    }

    place();
    const raf = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorEl, anchorRef, mine]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <>
      <button
        type="button"
        className="msg-menu__backdrop"
        aria-label="Закрыть меню"
        onClick={onClose}
      />
      <div
        ref={rootRef}
        className={`msg-menu ${mine ? "msg-menu--mine" : ""}`}
        role="menu"
        aria-label="Действия с сообщением"
        style={pos ? { top: pos.top, left: pos.left } : { opacity: 0 }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="msg-menu__reacts">
          <ReactionPicker
            compact
            onPick={(emoji) => {
              onReact(emoji);
              onClose();
            }}
          />
        </div>

        <div className="msg-menu__card">
          <button type="button" role="menuitem" onClick={onReply}>
            <IconReply size={16} />
            Ответить
          </button>
          {canCopy && (
            <button type="button" role="menuitem" onClick={onCopy}>
              <IconCopy size={16} />
              Копировать
            </button>
          )}
          {canDownload && onDownload && (
            <button type="button" role="menuitem" onClick={onDownload}>
              <IconDownload size={16} />
              Скачать
            </button>
          )}
          {canEdit && onEdit && (
            <button type="button" role="menuitem" onClick={onEdit}>
              <IconEdit size={16} />
              Изменить
            </button>
          )}
          {canForward && onForward && (
            <button type="button" role="menuitem" onClick={onForward}>
              <IconForward size={16} />
              Переслать
            </button>
          )}
          {canRetry && (
            <button type="button" role="menuitem" onClick={onRetry}>
              Повторить отправку
            </button>
          )}
          {canDiscard && (
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              onClick={onDiscard}
            >
              <IconTrash size={16} />
              Удалить
            </button>
          )}
          {canDelete && onDelete && (
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              onClick={onDelete}
            >
              <IconTrash size={16} />
              Удалить для всех
            </button>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
