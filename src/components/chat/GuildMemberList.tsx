"use client";

import { useMemo } from "react";
import { Avatar } from "@/components/chat/Avatar";
import type { PeopleUser } from "@/lib/types";

type GuildMemberListProps = {
  members: PeopleUser[];
  ownerId?: string;
  currentUserId: string;
  onSelectMember: (userId: string) => void;
};

function sortByName(a: PeopleUser, b: PeopleUser) {
  return (a.displayName || a.username).localeCompare(
    b.displayName || b.username,
    "ru",
  );
}

export function GuildMemberList({
  members,
  ownerId,
  currentUserId,
  onSelectMember,
}: GuildMemberListProps) {
  const { owner, online, offline } = useMemo(() => {
    const ownerMember = ownerId
      ? members.find((user) => user.id === ownerId) || null
      : null;
    const rest = members.filter((user) => user.id !== ownerId);
    return {
      owner: ownerMember,
      online: rest.filter((user) => user.online).sort(sortByName),
      offline: rest.filter((user) => !user.online).sort(sortByName),
    };
  }, [members, ownerId]);

  return (
    <aside className="member-rail" aria-label="Участники сервера">
      <div className="member-rail__scroll">
        {owner && (
          <section className="member-rail__section">
            <h3 className="member-rail__heading">
              Владелец — <span>1</span>
            </h3>
            <MemberRow
              user={owner}
              isOwner
              isSelf={owner.id === currentUserId}
              onSelect={() => onSelectMember(owner.id)}
            />
          </section>
        )}

        {online.length > 0 && (
          <section className="member-rail__section">
            <h3 className="member-rail__heading">
              В сети — <span>{online.length}</span>
            </h3>
            {online.map((user) => (
              <MemberRow
                key={user.id}
                user={user}
                isSelf={user.id === currentUserId}
                onSelect={() => onSelectMember(user.id)}
              />
            ))}
          </section>
        )}

        {offline.length > 0 && (
          <section className="member-rail__section">
            <h3 className="member-rail__heading">
              Не в сети — <span>{offline.length}</span>
            </h3>
            {offline.map((user) => (
              <MemberRow
                key={user.id}
                user={user}
                isSelf={user.id === currentUserId}
                onSelect={() => onSelectMember(user.id)}
              />
            ))}
          </section>
        )}

        {!owner && online.length === 0 && offline.length === 0 && (
          <p className="member-rail__empty">Пока никого нет</p>
        )}
      </div>
    </aside>
  );
}

function MemberRow({
  user,
  isOwner = false,
  isSelf = false,
  onSelect,
}: {
  user: PeopleUser;
  isOwner?: boolean;
  isSelf?: boolean;
  onSelect: () => void;
}) {
  const name = user.displayName || user.username;
  return (
    <button
      type="button"
      className={`person-item member-rail__row ${
        user.online ? "is-online" : "is-offline"
      } ${isOwner ? "is-owner" : ""}`}
      onClick={onSelect}
      title={isSelf ? "Вы" : `@${user.username}`}
    >
      <span className="person-item__avatar">
        <Avatar name={name} src={user.avatarUrl} size="sm" online={user.online} />
      </span>
      <span className="person-item__meta">
        <strong className={isOwner ? "member-rail__owner-name" : undefined}>
          {name}
          {isSelf ? " (вы)" : ""}
        </strong>
        <em>{isOwner ? "Создатель сервера" : `@${user.username}`}</em>
      </span>
    </button>
  );
}
