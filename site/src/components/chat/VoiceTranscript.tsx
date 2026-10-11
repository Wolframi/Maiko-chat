"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import type { ChatMessage } from "@/lib/types";
import { easeOut } from "@/lib/motion";
import { IconChevronDown, IconFileText } from "@/lib/icons";

type VoiceTranscriptProps = {
  message: ChatMessage;
  mine?: boolean;
  clock?: ReactNode;
  onTranscribe?: (messageId: string) => void;
};

export function VoiceTranscript({
  message,
  mine = false,
  clock,
  onTranscribe,
}: VoiceTranscriptProps) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const text = (message.transcription || "").trim();
  const status = message.transcriptionStatus;
  const pending = status === "pending";
  const error = status === "error";
  const empty = status === "ready" && !text;
  const failedSend = message.status === "pending" || message.status === "failed";

  if (failedSend || empty) {
    return clock ? (
      <div className="voice-transcript__bar voice-transcript__bar--clock-only">
        {clock}
      </div>
    ) : null;
  }

  const label = pending
    ? "Расшифровываю…"
    : text
      ? open
        ? "Свернуть"
        : "Показать текст"
      : error
        ? "Повторить расшифровку"
        : "Расшифровать";

  return (
    <div
      className={`voice-transcript ${mine ? "voice-transcript--mine" : ""} ${
        text && open ? "is-open" : ""
      }`}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="voice-transcript__toggle"
        disabled={pending && !text}
        aria-expanded={text ? open : undefined}
        aria-controls={text ? panelId : undefined}
        onClick={() => {
          if (text) {
            setOpen((value) => !value);
          } else {
            setOpen(true);
            onTranscribe?.(message.id);
          }
        }}
      >
        <IconFileText size={14} />
        <span>{label}</span>
        {text ? <IconChevronDown size={14} /> : null}
      </button>

      <AnimatePresence initial={false}>
        {text && open ? (
          <motion.div
            key="transcript"
            id={panelId}
            className="voice-transcript__panel"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              reduceMotion ? { duration: 0 } : { duration: 0.36, ease: easeOut }
            }
          >
            <p className="voice-transcript__text">{text}</p>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {error && !pending && !text ? (
        <div className="voice-transcript__error">
          <p>Не получилось расшифровать</p>
          <button type="button" onClick={() => {
            setOpen(true);
            onTranscribe?.(message.id);
          }}>
            Ещё раз
          </button>
        </div>
      ) : null}

      {clock ? <div className="voice-transcript__clock">{clock}</div> : null}
    </div>
  );
}
