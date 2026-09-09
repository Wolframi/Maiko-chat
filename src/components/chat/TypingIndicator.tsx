"use client";

import { memo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { softSpring } from "@/lib/motion";

type TypingIndicatorProps = {
  names: string[];
};

function shortName(name: string) {
  if (name.length <= 18) return name;
  return `${name.slice(0, 17)}…`;
}

function typingLabel(names: string[]) {
  if (names.length === 1) return `${shortName(names[0])} печатает…`;
  if (names.length === 2) {
    return `${shortName(names[0])} и ${shortName(names[1])} печатают…`;
  }
  return "Несколько человек печатают…";
}

function TypingIndicatorInner({ names }: TypingIndicatorProps) {
  const label = names.length ? typingLabel(names) : "";

  return (
    <div className="typing-slot" aria-live="polite" aria-atomic="true">
      <AnimatePresence>
        {names.length > 0 && (
          <motion.div
            className="typing"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
            transition={softSpring}
          >
            <span className="typing__dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="typing__label">{label}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export const TypingIndicator = memo(
  TypingIndicatorInner,
  (prev, next) =>
    prev.names.length === next.names.length &&
    prev.names.every((name, index) => name === next.names[index]),
);
