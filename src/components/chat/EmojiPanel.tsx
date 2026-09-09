"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import i18n from "@emoji-mart/data/i18n/ru.json";
import Picker from "@emoji-mart/react";
import { emojiMartRuData } from "@/lib/emojiMartRuData";
import { IconSmile } from "@/lib/icons";

type EmojiMartSelection = {
  native?: string;
  shortcodes?: string;
  id?: string;
};

type EmojiPanelProps = {
  onPick: (emoji: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  className?: string;
  closeOnSelect?: boolean;
  /** When true (default with trigger), float panel via portal so overflow parents don't clip it. */
  portal?: boolean;
};

export function EmojiPanel({
  onPick,
  open: openProp,
  onOpenChange,
  showTrigger = false,
  className = "",
  closeOnSelect = true,
  portal,
}: EmojiPanelProps) {
  const controlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlled ? Boolean(openProp) : internalOpen;
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const usePortal = portal ?? showTrigger;

  function setOpen(next: boolean) {
    if (!controlled) setInternalOpen(next);
    onOpenChange?.(next);
  }

  useLayoutEffect(() => {
    if (!open || !usePortal) {
      setPos(null);
      return;
    }
    function place() {
      const anchor = triggerRef.current || rootRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(352, window.innerWidth - 16);
      const height = Math.min(420, window.innerHeight - 24);
      let left = rect.right - width;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      let top = rect.top - height - 10;
      if (top < 8) {
        top = Math.min(rect.bottom + 10, window.innerHeight - height - 8);
      }
      setPos({ top, left, width });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, usePortal]);

  useEffect(() => {
    if (!open) return;
    function onDoc(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleSelect(emoji: EmojiMartSelection) {
    const native = emoji.native?.trim();
    if (!native) return;
    onPick(native);
    if (closeOnSelect) setOpen(false);
  }

  const showPanel = open && (!usePortal || Boolean(pos));

  const panelBody = (
    <motion.div
      key="emoji-panel"
      ref={panelRef}
      className={`emoji-panel ${usePortal ? "emoji-panel--portal" : ""}`}
      role="dialog"
      aria-label="Панель эмодзи"
      style={
        usePortal && pos
          ? {
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: pos.width,
              bottom: "auto",
              right: "auto",
            }
          : undefined
      }
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Picker
        data={emojiMartRuData}
        i18n={i18n}
        locale="ru"
        theme="dark"
        set="native"
        previewPosition="none"
        skinTonePosition="search"
        navPosition="top"
        searchPosition="sticky"
        dynamicWidth
        perLine={8}
        emojiSize={22}
        emojiButtonSize={36}
        emojiButtonRadius="10px"
        emojiButtonColors={["rgba(109, 138, 173, 0.28)"]}
        maxFrequentRows={2}
        onEmojiSelect={handleSelect}
      />
    </motion.div>
  );

  const layered = (
    <AnimatePresence>{showPanel ? panelBody : null}</AnimatePresence>
  );

  return (
    <div ref={rootRef} className={`emoji-panel-wrap ${className}`.trim()}>
      {showTrigger && (
        <button
          ref={triggerRef}
          type="button"
          className={`emoji-panel__trigger ${open ? "is-open" : ""}`}
          aria-label={open ? "Закрыть эмодзи" : "Эмодзи"}
          aria-expanded={open}
          title="Эмодзи"
          onClick={() => setOpen(!open)}
        >
          <IconSmile size={20} />
        </button>
      )}

      {usePortal && typeof document !== "undefined"
        ? createPortal(layered, document.body)
        : layered}
    </div>
  );
}
