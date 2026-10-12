"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  IconClose,
  IconPlus,
  IconSticker,
  IconTrash,
  IconUpload,
} from "@/lib/icons";
import type { StickerPack } from "@/lib/types";
import { MAX_STICKER_BYTES } from "@/lib/files";
import { StickerCropDialog } from "@/components/chat/StickerCropDialog";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";
import { layoutGifMosaic } from "@/lib/gifMosaic";

type StickerPickerProps = {
  open: boolean;
  onClose: () => void;
  onSend: (packId: string, stickerId: string) => void;
  packs: StickerPack[];
  refreshPacks: () => Promise<StickerPack[]>;
  onCreatePack: (
    title: string,
  ) => Promise<{ ok: boolean; pack?: StickerPack; error?: string }>;
  onDeletePack: (packId: string) => Promise<boolean>;
  onRenamePack: (packId: string, title: string) => Promise<boolean>;
  onAddSticker: (
    packId: string,
    file: File,
    extra?: {
      emoji?: string;
      width?: number;
      height?: number;
      animated?: boolean;
    },
  ) => Promise<{ ok: boolean; error?: string }>;
  onRemoveSticker: (packId: string, stickerId: string) => Promise<boolean>;
};
/** Разрешённые растровые картинки для стикеров (кроме GIF). */
const STATIC_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/webp",
  "image/avif",
]);
const STATIC_EXT = /\.(png|jpe?g|jfif|webp|avif)$/i;

/** Мозаика как у GIF-панели: ряды одной высоты, ширина по пропорциям. */
const STICKER_MOSAIC_TARGET_HEIGHT = 112;
const STICKER_MOSAIC_MAX_HEIGHT = 168;
const STICKER_MOSAIC_SPACING = 3;
const STICKER_MOSAIC_MIN_ITEM_WIDTH = 64;

function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function readVideoSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const size = { width: video.videoWidth, height: video.videoHeight };
      URL.revokeObjectURL(url);
      resolve(size);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

function isSupportedStickerFile(file: File) {
  const mime = (file.type || "").toLowerCase().split(";")[0].trim();
  const name = file.name.toLowerCase();
  // Анимированные — только WebM (VP9/VP8 с альфой).
  if (mime === "video/webm" || /\.webm$/i.test(name)) return true;
  // Статические: PNG / JPEG / WebP / AVIF (+ jfif).
  if (STATIC_MIME.has(mime) || STATIC_EXT.test(name)) return true;
  return false;
}

export function StickerPicker({
  open,
  onClose,
  onSend,
  packs,
  refreshPacks,
  onCreatePack,
  onDeletePack,
  onRenamePack,
  onAddSticker,
  onRemoveSticker,
}: StickerPickerProps) {
  const [activePackId, setActivePackId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [packTitle, setPackTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    packId: string;
    title: string;
    stickerId?: string;
  } | null>(null);
  const cropResolverRef = useRef<((file: File | null) => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const widthProbeRef = useRef<HTMLDivElement>(null);
  const [mosaicWidth, setMosaicWidth] = useState(0);

  const askCrop = useCallback(
    (file: File) =>
      new Promise<File | null>((resolve) => {
        cropResolverRef.current = resolve;
        setCropFile(file);
      }),
    [],
  );

  const handleCropComplete = useCallback((file: File) => {
    cropResolverRef.current?.(file);
    cropResolverRef.current = null;
    setCropFile(null);
  }, []);

  const handleCropCancel = useCallback(() => {
    cropResolverRef.current?.(null);
    cropResolverRef.current = null;
    setCropFile(null);
  }, []);

  useEffect(() => {
    const el = widthProbeRef.current;
    if (!el) return;
    const measure = () => {
      const next = Math.floor(
        el.clientWidth || el.parentElement?.clientWidth || 0,
      );
      if (next < 1) return;
      setMosaicWidth((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, activePackId]);

  useEffect(() => {
    if (!open) {
      setPendingDelete(null);
      return;
    }
    void refreshPacks();
  }, [open, refreshPacks]);

  useEffect(() => {
    if (!open) return;
    if (packs.length === 0) {
      setActivePackId(null);
      return;
    }
    if (!activePackId || !packs.some((p) => p.id === activePackId)) {
      setActivePackId(packs[0].id);
    }
  }, [open, packs, activePackId]);

  const activePack = useMemo(
    () => packs.find((p) => p.id === activePackId) ?? null,
    [packs, activePackId],
  );

  const mosaic = useMemo(() => {
    const stickers = activePack?.stickers ?? [];
    return layoutGifMosaic(
      stickers.map((s) => ({
        width: s.width || 512,
        height: s.height || 512,
      })),
      mosaicWidth || 360,
      STICKER_MOSAIC_SPACING,
      STICKER_MOSAIC_TARGET_HEIGHT,
      STICKER_MOSAIC_MAX_HEIGHT,
      STICKER_MOSAIC_MIN_ITEM_WIDTH,
    );
  }, [activePack, mosaicWidth]);

  const handleCreatePack = useCallback(async () => {
    const title = packTitle.trim();
    if (!title) return;
    const result = await onCreatePack(title);
    if (!result.ok || !result.pack) {
      toast.error(result.error || "Не удалось создать пак");
      return;
    }
    setActivePackId(result.pack.id);
    setPackTitle("");
    setCreating(false);
  }, [onCreatePack, packTitle]);

  const handlePickFiles = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target;
      const list = input.files ? Array.from(input.files) : [];
      input.value = "";
      if (!activePack || !activePack.canEdit || !list.length || uploading)
        return;
      setUploading(true);
      try {
        for (const file of list) {
          if (!isSupportedStickerFile(file)) {
            toast.error(
              `${file.name}: нужен PNG, JPG, WebP, AVIF или WebM`,
            );
            continue;
          }
          if (file.size > MAX_STICKER_BYTES) {
            toast.error(`${file.name}: файл больше 6 МБ`);
            continue;
          }
          const animated =
            /\.webm$/i.test(file.name) || file.type === "video/webm";
          let source = file;
          if (!animated) {
            // Static stickers get a square crop before upload.
            const cropped = await askCrop(file);
            if (!cropped) continue;
            source = cropped;
          }
          const size = animated
            ? await readVideoSize(source)
            : await readImageSize(source);
          const result = await onAddSticker(activePack.id, source, {
            animated,
            width: size?.width,
            height: size?.height,
          });
          if (!result.ok) {
            toast.error(result.error || "Не удалось добавить стикер");
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [activePack, onAddSticker, uploading, askCrop],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { packId, stickerId } = pendingDelete;
    setPendingDelete(null);
    try {
      const ok = stickerId
        ? await onRemoveSticker(packId, stickerId)
        : await onDeletePack(packId);
      if (!ok) {
        toast.error(stickerId ? "Не удалось удалить стикер" : "Не удалось удалить пак");
        return;
      }
      if (!stickerId) {
        toast("Пак удалён");
        setActivePackId((current) => current === packId ? null : current);
      }
    } catch {
      toast.error(stickerId ? "Не удалось удалить стикер" : "Не удалось удалить пак");
    }
  }, [pendingDelete, onDeletePack, onRemoveSticker]);

  const handleSaveRename = useCallback(async () => {
    if (!activePack) return;
    const next = renameValue.trim();
    if (!next || next === activePack.title) {
      setRenaming(false);
      return;
    }
    const ok = await onRenamePack(activePack.id, next);
    if (!ok) {
      toast.error("Не удалось переименовать");
      return;
    }
    setRenaming(false);
  }, [activePack, onRenamePack, renameValue]);

  if (!open) return null;

  return (
    <>
    <motion.div
      className="sticker-picker"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.18 }}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div className="sticker-picker__packs" role="tablist" aria-label="Паки стикеров">
        {packs.map((pack) => (
          <button
            key={pack.id}
            type="button"
            role="tab"
            aria-selected={activePackId === pack.id}
            className={`sticker-picker__pack ${
              activePackId === pack.id ? "is-active" : ""
            }`}
            onClick={() => {
              setActivePackId(pack.id);
              setRenaming(false);
            }}
            title={pack.title}
          >
            {pack.coverUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pack.coverUrl} alt="" draggable={false} />
            ) : (
              <IconSticker size={18} />
            )}
          </button>
        ))}
        <button
          type="button"
          className="sticker-picker__pack sticker-picker__pack--add"
          onClick={() => {
            setCreating((v) => !v);
            setRenaming(false);
          }}
          title={creating ? "Отмена" : "Создать пак"}
          aria-label={creating ? "Отмена" : "Создать пак"}
        >
          {creating ? <IconClose size={18} /> : <IconPlus size={18} />}
        </button>
      </div>

      {creating && (
        <div className="sticker-picker__create">
          <input
            type="text"
            value={packTitle}
            onChange={(e) => setPackTitle(e.target.value)}
            placeholder="Название пака"
            maxLength={40}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreatePack();
              if (e.key === "Escape") {
                setCreating(false);
                setPackTitle("");
              }
            }}
          />
          <button
            type="button"
            onClick={() => void handleCreatePack()}
            disabled={!packTitle.trim()}
          >
            Создать
          </button>
        </div>
      )}

      {activePack && !creating && (
        <div className="sticker-picker__head">
          {renaming ? (
            <input
              className="sticker-picker__rename"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={40}
              autoFocus
              onBlur={() => void handleSaveRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveRename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="sticker-picker__title"
              disabled={!activePack.canEdit}
              onClick={() => {
                if (!activePack.canEdit) return;
                setRenameValue(activePack.title);
                setRenaming(true);
              }}
              title={activePack.canEdit ? "Переименовать" : activePack.title}
            >
              {activePack.title}
              <span className="sticker-picker__count">
                {activePack.stickerCount} стикеров
              </span>
            </button>
          )}

          <div className="sticker-picker__head-actions">
            {activePack.canEdit && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.jfif,.webp,.avif,.webm,image/png,image/jpeg,image/webp,image/avif,video/webm"
                  multiple
                  hidden
                  onChange={(e) => void handlePickFiles(e)}
                />
                <button
                  type="button"
                  className="sticker-picker__action"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  title={uploading ? "Загрузка…" : "Добавить стикеры"}
                >
                  <IconUpload size={16} />
                  {uploading ? "…" : "Добавить"}
                </button>
                <button
                  type="button"
                  className="sticker-picker__action sticker-picker__action--danger"
                  onClick={() => setPendingDelete({ packId: activePack.id, title: activePack.title })}
                  title="Удалить пак"
                  aria-label="Удалить пак"
                >
                  <IconTrash size={16} />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Сетка стикеров — мозаика: ряды одной высоты, ширина по пропорциям */}
      <div className="sticker-picker__grid">
        <div ref={widthProbeRef} className="sticker-picker__mosaic-width" />
        {activePack?.stickers.length ? (
            <div
              className="sticker-picker__mosaic"
              style={{ height: mosaic.height }}
            >
              {activePack.stickers.map((sticker, index) => {
                const tile = mosaic.tiles[index];
                if (!tile) return null;
                return (
                  <div
                    key={sticker.id}
                    className="sticker-picker__item"
                    style={{
                      left: tile.x,
                      top: tile.y,
                      width: tile.width,
                      height: tile.height,
                    }}
                  >
                    <button
                      type="button"
                      className="sticker-picker__item-send"
                      onClick={() => onSend(activePack.id, sticker.id)}
                      title={sticker.name || "Стикер"}
                      aria-label={sticker.name || "Отправить стикер"}
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
                        />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={sticker.url}
                          alt=""
                          loading="lazy"
                          draggable={false}
                        />
                      )}
                    </button>
                    {activePack.canEdit && (
                      <button
                        type="button"
                        className="sticker-picker__item-remove"
                        aria-label="Удалить стикер"
                        title="Удалить стикер"
                        onClick={() => setPendingDelete({
                          packId: activePack.id,
                          title: activePack.title,
                          stickerId: sticker.id,
                        })}
                      >
                        <IconTrash size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
        ) : (
          <div className="sticker-picker__empty">
            {activePack?.canEdit
              ? "PNG, JPG, WebP, AVIF — статические. WebM/VP9 с альфой — анимированные. GIF не поддерживается."
              : "В паке пока нет стикеров"}
          </div>
        )}
      </div>
    </motion.div>
    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title={pendingDelete?.stickerId ? "Удалить стикер?" : "Удалить пак?"}
      body={pendingDelete?.stickerId
        ? `Стикер будет удалён из пака «${pendingDelete.title}». Это действие нельзя отменить.`
        : `Пак «${pendingDelete?.title ?? ""}» и все его стикеры будут удалены. Это действие нельзя отменить.`}
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => void handleConfirmDelete()}
    />
    <StickerCropDialog
      open={Boolean(cropFile)}
      file={cropFile}
      onCancel={handleCropCancel}
      onComplete={handleCropComplete}
    />
    </>
  );
}
