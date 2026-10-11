"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Cropper, { type Area } from "react-easy-crop";
import { getCroppedStickerFile } from "@/lib/cropImage";
import { IconClose } from "@/lib/icons";

type StickerCropDialogProps = {
  open: boolean;
  file: File | null;
  onCancel: () => void;
  onComplete: (file: File) => void;
};

export function StickerCropDialog({
  open,
  file,
  onCancel,
  onComplete,
}: StickerCropDialogProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !file) {
      setImageSrc(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImageSrc(url);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
    setError(null);
    setBusy(false);
    return () => URL.revokeObjectURL(url);
  }, [open, file]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

  async function handleApply() {
    if (!imageSrc || !croppedAreaPixels || busy) return;
    setBusy(true);
    setError(null);
    try {
      const cropped = await getCroppedStickerFile(
        imageSrc,
        croppedAreaPixels,
        0,
      );
      onComplete(cropped);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось обрезать стикер",
      );
      setBusy(false);
    }
  }

  if (!open || !file || typeof document === "undefined") return null;

  return createPortal(
    <div className="avatar-crop" role="presentation">
      <button
        type="button"
        className="avatar-crop__backdrop"
        aria-label="Закрыть"
        onClick={() => {
          if (!busy) onCancel();
        }}
      />
      <div
        className="avatar-crop__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sticker-crop-title"
      >
        <header className="avatar-crop__head">
          <h3 id="sticker-crop-title">Обрезать стикер</h3>
          <button
            type="button"
            className="icon-btn"
            aria-label="Закрыть"
            disabled={busy}
            onClick={onCancel}
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="avatar-crop__stage">
          {imageSrc ? (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="rect"
              showGrid
              zoomWithScroll
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
            />
          ) : null}
        </div>

        <p className="avatar-crop__hint">
          Перетащите картинку и увеличьте колёсиком / щипком. Прозрачность сохранится.
        </p>

        {error ? <p className="avatar-crop__error">{error}</p> : null}

        <div className="avatar-crop__actions">
          <button
            type="button"
            className="avatar-crop__cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Пропустить
          </button>
          <button
            type="button"
            className="avatar-crop__apply"
            disabled={busy || !croppedAreaPixels}
            onClick={() => void handleApply()}
          >
            {busy ? "Сохраняем…" : "Готово"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
