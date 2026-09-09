"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";

const EmojiPanel = dynamic(
  () => import("@/components/chat/EmojiPanel").then((mod) => mod.EmojiPanel),
  { ssr: false }
);

const QUICK = ["❤️", "🔥", "👍", "👏", "👎", "🥰", "😁"] as const;

type ReactionPickerProps = {
  onPick: (emoji: string) => void;
  compact?: boolean;
  /** When true, render as a fixed portal near the anchor. */
  portal?: boolean;
  anchorEl?: HTMLElement | null;
};

export function ReactionPicker({
  onPick,
  compact = false,
  portal = false,
  anchorEl = null,
}: ReactionPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!portal || !anchorEl) return;

    function place() {
      if (!anchorEl) return;
      const rect = anchorEl.getBoundingClientRect();
      const width = expanded ? 352 : 260;
      const height = expanded ? 400 : 56;
      let left = rect.right - width;
      let top = rect.top - height - 8;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      if (top < 8) top = rect.bottom + 8;
      setPos({ top, left });
    }

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [portal, anchorEl, expanded, compact]);

  const body = (
    <div
      ref={rootRef}
      className={`reaction-picker ${compact ? "reaction-picker--compact" : ""} ${
        portal ? "reaction-picker--portal" : ""
      }`}
      style={portal && pos ? { top: pos.top, left: pos.left } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="reaction-picker__quick">
        {QUICK.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="reaction-picker__chip"
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
        <button
          type="button"
          className={`reaction-picker__more ${expanded ? "is-open" : ""}`}
          aria-label={expanded ? "Скрыть эмодзи" : "Все эмодзи"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "▴" : "▾"}
        </button>
      </div>
      {expanded && (
        <EmojiPanel
          open
          closeOnSelect
          showTrigger={false}
          className="reaction-picker__panel"
          onOpenChange={(next) => {
            if (!next) setExpanded(false);
          }}
          onPick={onPick}
        />
      )}
    </div>
  );

  if (portal) {
    if (typeof document === "undefined" || !pos) return null;
    return createPortal(body, document.body);
  }

  return body;
}
