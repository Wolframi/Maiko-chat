"use client";

import { useState, useEffect, useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import dynamic from "next/dynamic";
import { IconKeyboard, IconSmile } from "@/lib/icons";
import { GifPicker } from "@/components/chat/GifPicker";
import { StickerPicker } from "@/components/chat/StickerPicker";
import type { StickerPack } from "@/lib/types";

const EmojiPanel = dynamic(
  () => import("@/components/chat/EmojiPanel").then((mod) => mod.EmojiPanel),
  { ssr: false }
);

type PickerTab = "emoji" | "stickers" | "gif";

type UnifiedPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEmojiPick: (emoji: string) => void;
  onGifPick: (
    url: string,
    size?: { width: number; height: number },
  ) => void;
  onStickerPick: (packId: string, stickerId: string) => void;
  portalRoot?: HTMLElement | null;
  onRevealKeyboard?: () => void;
  userId?: string;
  token?: string;
  stickerPacks: StickerPack[];
  refreshStickerPacks: () => Promise<StickerPack[]>;
  onCreateStickerPack: (title: string) => Promise<{ ok: boolean; pack?: StickerPack; error?: string }>;
  onDeleteStickerPack: (packId: string) => Promise<boolean>;
  onRenameStickerPack: (packId: string, title: string) => Promise<boolean>;
  onAddSticker: (
    packId: string,
    file: File,
    extra?: { emoji?: string; width?: number; height?: number; animated?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  onRemoveSticker: (packId: string, stickerId: string) => Promise<boolean>;
};

export function UnifiedPicker({
  open,
  onOpenChange,
  onEmojiPick,
  onGifPick,
  onStickerPick,
  portalRoot = null,
  onRevealKeyboard,
  userId = "",
  token = "",
  stickerPacks,
  refreshStickerPacks,
  onCreateStickerPack,
  onDeleteStickerPack,
  onRenameStickerPack,
  onAddSticker,
  onRemoveSticker,
}: UnifiedPickerProps) {
  const [tab, setTab] = useState<PickerTab>("emoji");
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [phone, setPhone] = useState(false);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    if (!open) setPanelHeight(null);
  }, [open]);

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    const el = panelRef.current;
    if (!el) return;
    event.preventDefault();
    resizeRef.current = {
      startY: event.clientY,
      startH: el.getBoundingClientRect().height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = resizeRef.current;
    if (!drag) return;
    // Тянем вверх — панель выше, вниз — ниже.
    const next = Math.round(drag.startH + (drag.startY - event.clientY));
    setPanelHeight(Math.min(560, Math.max(220, next)));
  }

  function handleResizeEnd() {
    resizeRef.current = null;
  }

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia("(max-width: 640px)");
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Открытый диалог обрезки сам обрабатывает Escape — не закрываем панель заодно.
        if (document.querySelector(".avatar-crop")) return;
        e.preventDefault();
        onOpenChange(false);
      }
    }

    function onDoc(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      // Диалог обрезки портируется в body — клики внутри него не должны закрывать панель.
      const cropDialog = document.querySelector(".avatar-crop");
      if (cropDialog && cropDialog.contains(target)) return;
      // Клик в область сообщения (поле ввода, кнопки композера) панель не закрывает.
      const composer = triggerRef.current?.closest(".composer");
      if (composer && composer.contains(target)) return;
      onOpenChange(false);
    }

    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDoc);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDoc);
    };
  }, [open, onOpenChange]);

  const handleEmojiPick = useCallback(
    (emoji: string) => {
      onEmojiPick(emoji);
    },
    [onEmojiPick],
  );

  const handleGifPick = useCallback(
    (url: string, size?: { width: number; height: number }) => {
      onGifPick(url, size);
      onOpenChange(false);
    },
    [onGifPick, onOpenChange],
  );

  const handleStickerSend = useCallback(
    (packId: string, stickerId: string) => {
      onStickerPick(packId, stickerId);
      onOpenChange(false);
    },
    [onStickerPick, onOpenChange],
  );

  function toggleOpen() {
    if (open) {
      onOpenChange(false);
      if (phone) onRevealKeyboard?.();
      return;
    }
    if (phone) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    }
    onOpenChange(true);
  }

  const panel = (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panelRef}
          className="unified-picker"
          style={panelHeight !== null ? { height: panelHeight } : undefined}
          initial={
            phone
              ? { opacity: 0, y: 16 }
              : { opacity: 0, y: 10, scale: 0.98 }
          }
          animate={
            phone ? { opacity: 1, y: 0 } : { opacity: 1, y: 0, scale: 1 }
          }
          exit={
            phone
              ? { opacity: 0, height: 0, transition: { duration: 0 } }
              : { opacity: 0, y: 10, scale: 0.95 }
          }
          transition={{ duration: phone ? 0.16 : 0.2 }}
        >
          <div
            className="unified-picker__resizer"
            aria-hidden
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
          />
          <div className="unified-picker__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "emoji"}
              className={`unified-picker__tab ${tab === "emoji" ? "is-active" : ""}`}
              onClick={() => setTab("emoji")}
            >
              Эмодзи
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "stickers"}
              className={`unified-picker__tab ${tab === "stickers" ? "is-active" : ""}`}
              onClick={() => setTab("stickers")}
            >
              Стикеры
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "gif"}
              className={`unified-picker__tab ${tab === "gif" ? "is-active" : ""}`}
              onClick={() => setTab("gif")}
            >
              GIF
            </button>
          </div>

          <div className="unified-picker__content">
            {tab === "emoji" && (
              <div className="unified-picker__pane unified-picker__pane--emoji">
                <EmojiPanel
                  open={true}
                  closeOnSelect={false}
                  showTrigger={false}
                  emojiSize={28}
                  onPick={handleEmojiPick}
                  onOpenChange={() => {}}
                />
              </div>
            )}

            {tab === "stickers" && (
              <div className="unified-picker__pane unified-picker__pane--stickers">
                {userId && token ? (
                  <StickerPicker
                    open={true}
                    onClose={() => onOpenChange(false)}
                    onSend={handleStickerSend}
                    packs={stickerPacks}
                    refreshPacks={refreshStickerPacks}
                    onCreatePack={onCreateStickerPack}
                    onDeletePack={onDeleteStickerPack}
                    onRenamePack={onRenameStickerPack}
                    onAddSticker={onAddSticker}
                    onRemoveSticker={onRemoveSticker}
                  />
                ) : (
                  <div className="unified-picker__empty">
                    Войдите, чтобы использовать стикеры
                  </div>
                )}
              </div>
            )}

            {tab === "gif" && (
              <div className="unified-picker__pane unified-picker__pane--gif">
                <GifPicker
                  open={true}
                  onSelect={handleGifPick}
                  onClose={() => onOpenChange(false)}
                />
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div ref={triggerRef} className="composer__picker">
      <button
        type="button"
        className={`composer__emoji-trigger ${open ? "is-open" : ""}`}
        onPointerDown={() => {
          if (!open && phone) {
            const active = document.activeElement;
            if (active instanceof HTMLElement) active.blur();
          }
        }}
        onClick={toggleOpen}
        aria-label={
          open && phone
            ? "Открыть клавиатуру"
            : open
              ? "Закрыть панель"
              : "Открыть эмодзи, стикеры, GIF"
        }
        aria-expanded={open}
        title={
          open && phone
            ? "Клавиатура"
            : "Эмодзи, стикеры, GIF"
        }
      >
        {open && phone ? (
          <IconKeyboard size={22} />
        ) : (
          <IconSmile size={22} />
        )}
      </button>

      {mounted && portalRoot ? createPortal(panel, portalRoot) : null}
    </div>
  );
}
