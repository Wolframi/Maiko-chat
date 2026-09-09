"use client";

import { memo } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { PeopleUser } from "@/lib/types";
import { softSpring } from "@/lib/motion";
import { Avatar } from "@/components/chat/Avatar";

type MentionMenuProps = {
  open: boolean;
  query: string;
  members: PeopleUser[];
  activeIndex: number;
  onPick: (user: PeopleUser) => void;
  onHover: (index: number) => void;
};

function MentionMenuInner({
  open,
  query,
  members,
  activeIndex,
  onPick,
  onHover,
}: MentionMenuProps) {
  const q = query.trim().toLowerCase();
  const filtered = members
    .filter((user) => {
      if (!q) return true;
      return (
        user.displayName.toLowerCase().includes(q) ||
        user.username.toLowerCase().includes(q)
      );
    })
    .slice(0, 8);

  return (
    <AnimatePresence>
      {open && filtered.length > 0 && (
        <motion.div
          className="mention-menu"
          role="listbox"
          aria-label="Упоминания"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={softSpring}
        >
          {filtered.map((user, index) => (
            <button
              key={user.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`mention-menu__item ${
                index === activeIndex ? "is-active" : ""
              }`}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(user);
              }}
            >
              <Avatar
                name={user.displayName || user.username}
                src={user.avatarUrl}
                size="sm"
                online={user.online}
              />
              <span className="mention-menu__meta">
                <strong>{user.displayName}</strong>
                <em>@{user.username}</em>
              </span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const MentionMenu = memo(MentionMenuInner);
