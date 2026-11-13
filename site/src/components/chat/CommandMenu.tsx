"use client";

import { memo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { softSpring } from "@/lib/motion";
import type { BotCommandInfo } from "@/lib/types";

type CommandMenuProps = {
  open: boolean;
  commands: BotCommandInfo[];
  activeIndex: number;
  onPick: (command: BotCommandInfo) => void;
  onHover: (index: number) => void;
};

/** Telegram-style `/` autocomplete above the composer. */
function CommandMenuInner({
  open,
  commands,
  activeIndex,
  onPick,
  onHover,
}: CommandMenuProps) {
  return (
    <AnimatePresence>
      {open && commands.length > 0 && (
        <motion.div
          className="command-menu"
          role="listbox"
          aria-label="Команды бота"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={softSpring}
        >
          {commands.map((item, index) => (
            <button
              key={item.command}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`command-menu__item${index === activeIndex ? " is-active" : ""}`}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(item);
              }}
            >
              <span className="command-menu__name">/{item.command}</span>
              {item.description ? (
                <span className="command-menu__desc">{item.description}</span>
              ) : null}
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const CommandMenu = memo(CommandMenuInner);
