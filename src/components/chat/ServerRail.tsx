"use client";

import { motion } from "motion/react";
import type { ChatInfo } from "@/lib/types";
import { IconPlus, IconUsers } from "@/lib/icons";
import { popSpring } from "@/lib/motion";

/** home = inbox, dms = people, create = new group, else group chat id */
export type RailFocus = "home" | "dms" | "create" | (string & {});

type ServerRailProps = {
  focus: RailFocus;
  groups: ChatInfo[];
  unreadHome?: number;
  onSelectHome: () => void;
  onSelectDms: () => void;
  onSelectGroup: (groupId: string) => void;
  onCreate?: () => void;
};

function initials(title: string) {
  const parts = title.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "G";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

export function ServerRail({
  focus,
  groups,
  unreadHome = 0,
  onSelectHome,
  onSelectDms,
  onSelectGroup,
  onCreate,
}: ServerRailProps) {
  return (
    <nav className="server-rail" aria-label="Серверы и группы">
      <button
        type="button"
        className={`server-rail__orb server-rail__orb--home ${
          focus === "home" ? "is-active" : ""
        }`}
        aria-label="Чаты"
        title="Чаты"
        aria-current={focus === "home" ? "true" : undefined}
        onClick={onSelectHome}
      >
        <span className="server-rail__pulse" aria-hidden>
          P
        </span>
        {unreadHome > 0 && (
          <em className="server-rail__badge">
            {unreadHome > 99 ? "99+" : unreadHome}
          </em>
        )}
        {focus === "home" && (
          <motion.span
            className="server-rail__active-pill"
            layoutId="server-rail-active"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          />
        )}
      </button>

      <motion.button
        type="button"
        className={`server-rail__orb ${focus === "dms" ? "is-active" : ""}`}
        aria-label="Люди"
        title="Люди"
        aria-current={focus === "dms" ? "true" : undefined}
        onClick={onSelectDms}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
      >
        <IconUsers size={22} />
        {focus === "dms" && (
          <motion.span
            className="server-rail__active-pill"
            layoutId="server-rail-active"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          />
        )}
      </motion.button>

      {groups.length > 0 && <span className="server-rail__sep" aria-hidden />}

      {groups.map((group) => {
        const active = focus === group.id;
        const unread =
          group.unreadCount > 99 ? "99+" : String(group.unreadCount || "");
        return (
          <motion.button
            key={group.id}
            type="button"
            className={`server-rail__orb server-rail__orb--guild ${
              active ? "is-active" : ""
            }`}
            aria-label={group.title}
            title={group.title}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelectGroup(group.id)}
            /* Avoid transform:scale on photo orbs — it softens bitmap avatars. */
            whileHover={group.avatarUrl ? undefined : { scale: 1.06 }}
            whileTap={group.avatarUrl ? undefined : { scale: 0.94 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          >
            {group.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="server-rail__avatar"
                src={String(group.avatarUrl).split("?")[0]}
                alt=""
                decoding="async"
              />
            ) : (
              <span className="server-rail__guild-initials" aria-hidden>
                {initials(group.title)}
              </span>
            )}
            {group.unreadCount > 0 && !active && (
              <em className="server-rail__badge">{unread}</em>
            )}
            {active && (
              <motion.span
                className="server-rail__active-pill"
                layoutId="server-rail-active"
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              />
            )}
          </motion.button>
        );
      })}

      {onCreate && (
        <>
          <span className="server-rail__sep" aria-hidden />
          <motion.button
            type="button"
            className={`server-rail__orb server-rail__orb--add ${
              focus === "create" ? "is-active" : ""
            }`}
            aria-label="Создать группу"
            title="Создать группу"
            onClick={onCreate}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            transition={popSpring}
          >
            <IconPlus size={22} />
          </motion.button>
        </>
      )}
    </nav>
  );
}
