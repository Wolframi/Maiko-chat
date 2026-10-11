"use client";

import { useEffect, useRef, useState } from "react";
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
  portal?: boolean;
  emojiSize?: number;
};

export function EmojiPanel({
  onPick,
  open: openProp,
  onOpenChange,
  showTrigger = false,
  className = "",
  closeOnSelect = true,
  portal,
  emojiSize = 32,
}: EmojiPanelProps) {
  const controlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlled ? Boolean(openProp) : internalOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const usePortal = portal ?? showTrigger;

  function setOpen(next: boolean) {
    if (!controlled) setInternalOpen(next);
    onOpenChange?.(next);
  }

  useEffect(() => {
    if (!open) return;
    // Embedded in UnifiedPicker — parent owns outside-click / Escape.
    if (!showTrigger) return;
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
    document.addEventListener("pointerdown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, showTrigger]);

  function handleSelect(emoji: EmojiMartSelection) {
    const native = emoji.native?.trim();
    if (!native) return;
    onPick(native);
    if (closeOnSelect) setOpen(false);
  }

  const showPanel = open;

  const panelBody = (
    <div
      ref={panelRef}
      className="emoji-panel"
      role="dialog"
      aria-label="Панель эмодзи"
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
        perLine={9}
        emojiSize={emojiSize}
        emojiButtonSize={emojiSize + 12}
        emojiButtonRadius="8px"
        emojiButtonColors={["rgba(76, 109, 169, 0.28)"]}
        maxFrequentRows={1}
        onEmojiSelect={handleSelect}
      />
    </div>
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
          <IconSmile size={24} />
        </button>
      )}

      {usePortal && typeof document !== "undefined"
        ? createPortal(layered, document.body)
        : layered}
    </div>
  );
}