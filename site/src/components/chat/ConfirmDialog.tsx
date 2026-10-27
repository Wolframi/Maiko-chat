"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Удалить",
  cancelLabel = "Отмена",
  danger = true,
  busy = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = busy ? () => undefined : onCancel; }, [onCancel, busy]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    cancelRef.current?.focus();
    function containFocus(event: FocusEvent) {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target)) {
        cancelRef.current?.focus();
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
      }
      if (event.key === "Tab") {
        const buttons = cardRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)");
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", containFocus);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="confirm-dialog" role="presentation">
      <button
        type="button"
        className="confirm-dialog__backdrop"
        aria-label="Закрыть"
        onClick={() => { if (!busy) onCancel(); }}
      />
      <div
        ref={cardRef}
        className="confirm-dialog__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h3 id="confirm-dialog-title" className="confirm-dialog__title">
          {title}
        </h3>
        {body ? <p className="confirm-dialog__body">{body}</p> : null}
        {children}
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="confirm-dialog__cancel"
            ref={cancelRef}
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-dialog__confirm ${danger ? "is-danger" : ""}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Подождите…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
