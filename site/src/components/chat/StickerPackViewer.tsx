"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { IconClose, IconPlus, IconCheck } from "@/lib/icons";
import type { StickerPack } from "@/lib/types";
import { sheetSpring } from "@/lib/motion";

type StickerPackViewerProps = {
  open: boolean;
  packId: string | null;
  focusStickerId?: string | null;
  fetchPack: (packId: string) => Promise<StickerPack | null>;
  onSend: (packId: string, stickerId: string) => void;
  onInstall: (packId: string) => Promise<boolean>;
  onUninstall: (packId: string) => Promise<boolean>;
  onClose: () => void;
};

/** Высота одной строки стикеров (px). */
const ROW_H = 130;
/** Внутренний отступ ячейки. */
const CELL_PAD = 10;

export function StickerPackViewer({
  open,
  packId,
  focusStickerId = null,
  fetchPack,
  onSend,
  onInstall,
  onUninstall,
  onClose,
}: StickerPackViewerProps) {
  const [pack, setPack] = useState<StickerPack | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || !packId) {
      setPack(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void fetchPack(packId)
      .then((next) => {
        if (!next) {
          // Пака больше нет (удалил владелец) — не открываем вообще.
          setPack(null);
          setError(null);
          onCloseRef.current();
          toast.error("Этот пак стикеров больше не существует");
          return;
        }
        setPack(next);
      })
      .catch(() => {
        setError("Не удалось загрузить пак");
      })
      .finally(() => setLoading(false));
  }, [open, packId, fetchPack]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!pack || !focusStickerId) return;
    const node = gridRef.current?.querySelector<HTMLElement>(
      `[data-sticker-id="${CSS.escape(focusStickerId)}"]`,
    );
    if (node) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("is-focus");
      window.setTimeout(() => node.classList.remove("is-focus"), 1800);
    }
  }, [pack, focusStickerId]);

  const handleInstall = useCallback(async () => {
    if (!pack || installing) return;
    setInstalling(true);
    try {
      const ok = await onInstall(pack.id);
      if (!ok) {
        toast.error("Не удалось добавить пак");
        return;
      }
      setPack((prev) => (prev ? { ...prev, installed: true } : prev));
      toast.success("Пак добавлен");
    } finally {
      setInstalling(false);
    }
  }, [pack, installing, onInstall]);

  const handleUninstall = useCallback(async () => {
    if (!pack || uninstalling) return;
    setUninstalling(true);
    try {
      const ok = await onUninstall(pack.id);
      if (!ok) {
        toast.error("Не удалось убрать пак");
        return;
      }
      setPack((prev) => (prev ? { ...prev, installed: false } : prev));
      toast("Пак убран из ваших");
    } finally {
      setUninstalling(false);
    }
  }, [pack, uninstalling, onUninstall]);

  return (
    <AnimatePresence>
      {open && (
        <div className="sticker-viewer" role="dialog" aria-modal="true">
          <motion.button
            type="button"
            className="sticker-viewer__backdrop"
            aria-label="Закрыть"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            className="sticker-viewer__card"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.99 }}
            transition={sheetSpring}
            style={{
              display: "flex",
              flexDirection: "column",
              /* Явная высота + ширина — без этого grid схлопывался в 0 */
              width: "min(640px, calc(100vw - 32px))",
              height: "min(92dvh, 860px)",
              maxWidth: "calc(100vw - 32px)",
              maxHeight: "92dvh",
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <header className="sticker-viewer__head">
              <div className="sticker-viewer__meta">
                <h2>{pack?.title || "Пак стикеров"}</h2>
                <span>
                  {pack?.ownerName ? `Автор: ${pack.ownerName} · ` : ""}
                  {pack?.stickerCount ?? 0} стикеров
                </span>
              </div>
              <div className="sticker-viewer__actions">
                {pack && !pack.installed && (
                  <button
                    type="button"
                    className="sticker-viewer__install"
                    onClick={() => void handleInstall()}
                    disabled={installing}
                  >
                    <IconPlus size={16} />
                    {installing ? "Добавляем…" : "Добавить пак"}
                  </button>
                )}
                {pack?.installed && !pack.canEdit && (
                  <button
                    type="button"
                    className="sticker-viewer__install"
                    onClick={() => void handleUninstall()}
                    disabled={uninstalling}
                  >
                    <IconClose size={16} />
                    {uninstalling ? "Убираем…" : "Убрать пак"}
                  </button>
                )}
                {pack?.installed && pack.canEdit && (
                  <span className="sticker-viewer__installed">
                    <IconCheck size={14} />
                    Ваш пак
                  </span>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Закрыть"
                  onClick={onClose}
                >
                  <IconClose />
                </button>
              </div>
            </header>

            {loading && <p className="sticker-viewer__status">Загрузка…</p>}
            {error && !loading && (
              <p className="sticker-viewer__status sticker-viewer__status--error">
                {error}
              </p>
            )}

            {pack && (
              <div
                ref={gridRef}
                style={{
                  flex: "1 1 0",
                  minHeight: 0,
                  overflowY: "auto",
                  overflowX: "hidden",
                  display: "grid",
                  /* Ровно 4 колонки, независимо от ширины карточки */
                  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                  gridAutoRows: `${ROW_H}px`,
                  gap: 8,
                  padding: "14px 16px 18px",
                  alignContent: "start",
                  justifyItems: "stretch",
                  scrollbarWidth: "thin",
                }}
              >
                {pack.stickers.map((sticker) => (
                  <button
                    key={sticker.id}
                    type="button"
                    data-sticker-id={sticker.id}
                    onClick={() => {
                      if (!pack.installed) {
                        toast(
                          "Сначала добавьте пак, чтобы отправлять стикеры",
                        );
                        return;
                      }
                      onSend(pack.id, sticker.id);
                    }}
                    title={sticker.name || "Отправить"}
                    style={{
                      position: "relative",
                      width: "100%",
                      height: ROW_H,
                      padding: CELL_PAD,
                      border: "1px solid transparent",
                      borderRadius: 14,
                      background: "rgba(255, 255, 255, 0.03)",
                      cursor: "pointer",
                      overflow: "hidden",
                      boxSizing: "border-box",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition:
                        "background 0.15s ease, border-color 0.15s ease",
                    }}
                  >
                    {sticker.animated ? (
                      <video
                        src={sticker.url}
                        autoPlay
                        loop
                        muted
                        playsInline
                        preload="metadata"
                        aria-hidden
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          objectPosition: "center",
                          display: "block",
                          pointerEvents: "none",
                        }}
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={sticker.url}
                        alt=""
                        draggable={false}
                        loading="lazy"
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          objectPosition: "center",
                          display: "block",
                          pointerEvents: "none",
                        }}
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}