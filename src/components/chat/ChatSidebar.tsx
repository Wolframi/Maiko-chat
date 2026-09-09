"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import type {
  ChatInfo,
  GroupVisibility,
  PeopleUser,
  PublicGroupHit,
} from "@/lib/types";
import { Avatar } from "@/components/chat/Avatar";
import {
  IconClose,
  IconHash,
  IconHeadphones,
  IconMicOff,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUserPlus,
  IconVolume,
} from "@/lib/icons";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";
import { formatChatListTime } from "@/lib/dates";
import { isChatMuted } from "@/lib/mute";
import { easeOutSoft, panelVariants } from "@/lib/motion";
import type { RailFocus } from "@/components/chat/ServerRail";

type ChatSidebarProps = {
  chats: ChatInfo[];
  people: PeopleUser[];
  currentUserId?: string;
  currentChatId?: string;
  focus: RailFocus;
  onFocusChange: (focus: RailFocus) => void;
  onOpenChat: (chatId: string) => void;
  onOpenDm: (userId: string) => void;
  onCreateGroup: (
    title: string,
    topic: string,
    visibility: GroupVisibility,
  ) => Promise<{ ok: boolean; error?: string }>;
  onInviteToGroup?: (groupId: string, userId: string) => void;
  onSearchPeople?: (query: string) => Promise<PeopleUser[]>;
  onSuggestPeople?: () => Promise<PeopleUser[]>;
  onSearchGroups?: (
    query: string,
  ) => Promise<{ ok: boolean; groups: PublicGroupHit[] }>;
  onJoinGroup?: (groupId: string) => Promise<{ ok: boolean; error?: string }>;
  onToggleMute?: (chatId: string) => void;
  mutedVersion?: number;
  onClose?: () => void;
  onMarkAllRead?: () => void;
  error?: string | null;
  searchRef?: RefObject<HTMLInputElement | null>;
  activeVoiceChannelId?: string | null;
  voiceJoining?: boolean;
  onJoinVoice?: (channelId: string, groupId: string, title: string) => void;
  onCreateVoiceChannel?: (groupId: string, title: string) => void;
  onDeleteVoiceChannel?: (groupId: string, channelId: string) => void;
};

function matchesQuery(value: string, query: string) {
  return value.toLowerCase().includes(query.toLowerCase());
}

function ChatRow({
  chat,
  active,
  avatarUrl,
  muted,
  online,
  onClick,
  onToggleMute,
}: {
  chat: ChatInfo;
  active: boolean;
  avatarUrl?: string;
  muted?: boolean;
  online?: boolean;
  onClick: () => void;
  onToggleMute?: (chatId: string) => void;
}) {
  const title = chat.type === "channel" ? `#${chat.title}` : chat.title;
  const preview = chat.lastMessage
    ? `${chat.lastMessage.author}: ${chat.lastMessage.text}`
    : chat.topic;
  const unreadLabel =
    chat.unreadCount > 99 ? "99+" : String(chat.unreadCount);

  return (
    <div
      className={`room-item ${active ? "room-item--active" : ""} ${
        chat.unreadCount > 0 ? "room-item--unread" : ""
      } ${muted ? "room-item--muted" : ""}`}
    >
      <button
        type="button"
        className="room-item__main"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
      >
        {chat.type === "channel" ? (
          <span className="room-item__glyph" aria-hidden>
            <IconHash size={20} />
          </span>
        ) : (
          <Avatar
            name={chat.title}
            src={avatarUrl}
            size="md"
            online={online}
          />
        )}
        <span className="room-item__body">
          <span className="room-item__top">
            <span className="room-item__title">
              {chat.type !== "dm" && muted && (
                <IconMicOff size={12} className="room-item__mute-icon" />
              )}
              {title}
            </span>
            {chat.lastMessage ? (
              <time
                className="room-item__time"
                dateTime={new Date(chat.lastMessage.createdAt).toISOString()}
              >
                {formatChatListTime(chat.lastMessage.createdAt)}
              </time>
            ) : chat.online > 0 ? (
              <span className="room-item__online">{chat.online}</span>
            ) : null}
          </span>
          <span className="room-item__bottom">
            <span className="room-item__preview">{preview}</span>
            {chat.unreadCount > 0 && (
              <span
                className={`room-item__unread ${muted ? "is-muted" : ""}`}
              >
                {unreadLabel}
              </span>
            )}
          </span>
        </span>
      </button>
      {chat.type !== "dm" && onToggleMute && (
        <button
          type="button"
          className={`room-item__mute ${muted ? "is-on" : ""}`}
          aria-label={muted ? "Включить звук" : "Без звука"}
          title={muted ? "Включить звук" : "Без звука"}
          onClick={() => onToggleMute(chat.id)}
        >
          <IconMicOff size={14} />
        </button>
      )}
    </div>
  );
}

export function ChatSidebar({
  chats,
  people,
  currentUserId,
  currentChatId,
  focus,
  onFocusChange,
  onOpenChat,
  onOpenDm,
  onCreateGroup,
  onInviteToGroup,
  onSearchPeople,
  onSuggestPeople,
  onSearchGroups,
  onJoinGroup,
  onToggleMute,
  mutedVersion = 0,
  onClose,
  onMarkAllRead,
  error,
  searchRef,
  activeVoiceChannelId = null,
  voiceJoining = false,
  onJoinVoice,
  onCreateVoiceChannel,
  onDeleteVoiceChannel,
}: ChatSidebarProps) {
  const localSearchRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef || localSearchRef;
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<GroupVisibility>("public");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<PeopleUser[]>([]);
  const [suggestedPeople, setSuggestedPeople] = useState<PeopleUser[]>([]);
  const [groupHits, setGroupHits] = useState<PublicGroupHit[]>([]);
  const [joiningGroupId, setJoiningGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [inviteQuery, setInviteQuery] = useState("");
  const [inviteHits, setInviteHits] = useState<PeopleUser[]>([]);
  const [voiceTitle, setVoiceTitle] = useState("");
  const [creatingVoice, setCreatingVoice] = useState(false);
  const [pendingVoiceDelete, setPendingVoiceDelete] = useState<{
    groupId: string;
    channelId: string;
    title: string;
  } | null>(null);

  useEffect(() => {
    if (focus !== "dms" || !onSuggestPeople) {
      setSuggestedPeople([]);
      return;
    }
    let cancelled = false;
    void onSuggestPeople().then((users) => {
      if (!cancelled) setSuggestedPeople(users);
    });
    return () => {
      cancelled = true;
    };
  }, [focus, onSuggestPeople]);

  useEffect(() => {
    if (focus !== "dms") {
      setSearchHits([]);
      setGroupHits([]);
      return;
    }
    const q = query.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (onSearchPeople && q.length >= 1) {
        void onSearchPeople(q).then((users) => {
          if (!cancelled) setSearchHits(users);
        });
      } else {
        setSearchHits([]);
      }
      if (onSearchGroups) {
        void onSearchGroups(q).then((result) => {
          if (cancelled) return;
          // Keep previous hits on rate-limit / error — don't flash "not found".
          if (result.ok) setGroupHits(result.groups);
        });
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, focus, onSearchPeople, onSearchGroups]);

  function activeGuildPending(value: RailFocus) {
    return value !== "home" && value !== "dms" && value !== "create";
  }

  useEffect(() => {
    if (!activeGuildPending(focus) || !onSearchPeople) {
      setInviteHits([]);
      return;
    }
    const q = inviteQuery.trim();
    if (q.length < 1) {
      setInviteHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onSearchPeople(q).then((users) => {
        if (!cancelled) setInviteHits(users);
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inviteQuery, focus, onSearchPeople]);

  const mutedIds = useMemo(() => {
    const set = new Set<string>();
    for (const chat of chats) {
      if (isChatMuted(chat.id)) set.add(chat.id);
    }
    void mutedVersion;
    return set;
  }, [chats, mutedVersion]);

  const filtered = useMemo(() => {
    if (!query.trim()) return chats;
    return chats.filter(
      (chat) =>
        matchesQuery(chat.title, query) ||
        matchesQuery(chat.topic || "", query) ||
        matchesQuery(chat.lastMessage?.text || "", query) ||
        matchesQuery(chat.lastMessage?.author || "", query),
    );
  }, [chats, query]);

  // Home is DM-only; groups live in the server rail / guild sidebar.
  const dms = useMemo(
    () => filtered.filter((chat) => chat.type === "dm"),
    [filtered],
  );

  const others = useMemo(() => {
    const q = query.trim();
    // While searching — trust server results (full user directory).
    if (q) {
      const byId = new Map<string, PeopleUser>();
      for (const user of searchHits) {
        if (user.id !== currentUserId) byId.set(user.id, user);
      }
      // Keep local matches too (e.g. while the request is in flight).
      for (const user of people) {
        if (user.id === currentUserId || byId.has(user.id)) continue;
        if (
          matchesQuery(user.displayName || "", q) ||
          matchesQuery(user.username, q)
        ) {
          byId.set(user.id, user);
        }
      }
      return [...byId.values()];
    }
    // Empty query: suggested directory (online first), fall back to contacts.
    if (suggestedPeople.length) {
      return suggestedPeople.filter((user) => user.id !== currentUserId);
    }
    return people.filter((user) => user.id !== currentUserId);
  }, [people, currentUserId, query, searchHits, suggestedPeople]);

  const peopleById = useMemo(() => {
    const map = new Map<string, PeopleUser>();
    for (const user of people) map.set(user.id, user);
    return map;
  }, [people]);

  const activeGuild = useMemo(() => {
    if (focus === "home" || focus === "dms" || focus === "create") return null;
    return chats.find((chat) => chat.id === focus && chat.type === "group") || null;
  }, [chats, focus]);

  const inviteCandidates = useMemo(() => {
    if (!activeGuild) return [];
    const members = new Set(activeGuild.memberIds || []);
    const byId = new Map<string, PeopleUser>();
    for (const user of people) {
      if (user.id !== currentUserId && !members.has(user.id)) {
        byId.set(user.id, user);
      }
    }
    for (const user of inviteHits) {
      if (user.id !== currentUserId && !members.has(user.id)) {
        byId.set(user.id, user);
      }
    }
    let list = [...byId.values()];
    const q = inviteQuery.trim();
    if (q) {
      list = list.filter(
        (user) =>
          matchesQuery(user.displayName || "", q) ||
          matchesQuery(user.username, q),
      );
    }
    list.sort((a, b) =>
      (a.displayName || a.username).localeCompare(
        b.displayName || b.username,
        "ru",
      ),
    );
    return list.slice(0, 80);
  }, [activeGuild, people, inviteHits, currentUserId, inviteQuery]);

  const brandTitle =
    focus === "dms"
      ? "Люди"
      : focus === "create"
        ? "Новая группа"
        : activeGuild
          ? activeGuild.title
          : "Чаты";
  const brandTag =
    focus === "dms"
      ? "Люди и открытые группы"
      : focus === "create"
        ? "Открытая или закрытая"
        : activeGuild
          ? activeGuild.topic || "Текстовые каналы"
          : "Диалоги";

  function handleCreateGroup(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || creatingGroup) return;
    const nextTitle = title;
    const nextTopic = topic;
    const nextVisibility = visibility;
    setCreatingGroup(true);
    void onCreateGroup(nextTitle, nextTopic, nextVisibility)
      .then((result) => {
        if (!result.ok) return;
        setTitle("");
        setTopic("");
        setVisibility("public");
      })
      .finally(() => setCreatingGroup(false));
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <div className={`sidebar__head-main ${activeGuild ? "has-guild" : ""}`}>
          {activeGuild ? (
            <Avatar
              name={activeGuild.title}
              src={activeGuild.avatarUrl}
              size="md"
            />
          ) : null}
          <div>
            <p className="sidebar__brand">{brandTitle}</p>
            <p className="sidebar__tagline">
              {activeGuild
                ? `${activeGuild.visibility === "private" ? "Закрытая" : "Открытая"} · ${brandTag}`
                : brandTag}
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            className="icon-btn sidebar__close"
            aria-label="Закрыть меню"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        )}
      </div>

      {(focus === "home" || focus === "dms") && (
        <label className="sidebar__search">
          <IconSearch size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              focus === "dms" ? "Имя, логин или группа…" : "Поиск диалогов…"
            }
            aria-label={
              focus === "dms" ? "Поиск людей и групп" : "Поиск диалогов"
            }
          />
          {query.trim() ? (
            <button
              type="button"
              className="sidebar__search-clear"
              aria-label="Очистить поиск"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <IconClose size={14} />
            </button>
          ) : null}
        </label>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={
            focus === "home" || focus === "dms" || focus === "create"
              ? focus
              : `guild-${focus}`
          }
          className="sidebar__panel"
          role="tabpanel"
          initial="initial"
          animate="animate"
          exit="exit"
          variants={panelVariants}
          transition={{ duration: 0.28, ease: easeOutSoft }}
        >
          {focus === "home" && onMarkAllRead && (
            <button
              type="button"
              className="sidebar__mark-read"
              onClick={onMarkAllRead}
            >
              Прочитать все
            </button>
          )}

          {error && <p className="sidebar__error">{error}</p>}

          {activeGuild && (
            <div className="sidebar__list sidebar__list--guild">
              <p className="sidebar__section">Текстовые каналы</p>
              <button
                type="button"
                className={`channel-item ${
                  currentChatId === activeGuild.id ? "is-active" : ""
                }`}
                onClick={() => onOpenChat(activeGuild.id)}
              >
                <IconHash size={16} />
                <span>general</span>
                {activeGuild.unreadCount > 0 && (
                  <em>
                    {activeGuild.unreadCount > 99
                      ? "99+"
                      : activeGuild.unreadCount}
                  </em>
                )}
              </button>
              {activeGuild.topic ? (
                <p className="sidebar__hint sidebar__hint--guild">
                  {activeGuild.topic}
                </p>
              ) : null}

              <div className="sidebar__section-row">
                <p className="sidebar__section">Голосовые каналы</p>
                {onCreateVoiceChannel && (
                  <button
                    type="button"
                    className={`sidebar__section-add ${
                      creatingVoice ? "is-open" : ""
                    }`}
                    aria-label={
                      creatingVoice
                        ? "Отменить создание"
                        : "Создать голосовой канал"
                    }
                    title={
                      creatingVoice
                        ? "Отменить"
                        : "Создать голосовой канал"
                    }
                    onClick={() => {
                      if (creatingVoice) {
                        setCreatingVoice(false);
                        setVoiceTitle("");
                        return;
                      }
                      setCreatingVoice(true);
                    }}
                  >
                    {creatingVoice ? (
                      <IconClose size={14} />
                    ) : (
                      <IconPlus size={14} />
                    )}
                  </button>
                )}
              </div>

              {creatingVoice && onCreateVoiceChannel && (
                <form
                  className="voice-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = voiceTitle.trim() || "Голосовой";
                    onCreateVoiceChannel(activeGuild.id, name);
                    setVoiceTitle("");
                    setCreatingVoice(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCreatingVoice(false);
                      setVoiceTitle("");
                    }
                  }}
                >
                  <input
                    value={voiceTitle}
                    onChange={(event) => setVoiceTitle(event.target.value)}
                    placeholder="Название канала"
                    maxLength={40}
                    aria-label="Название голосового канала"
                    autoFocus
                  />
                  <div className="voice-create__actions">
                    <button type="submit" className="voice-create__submit">
                      Создать
                    </button>
                    <button
                      type="button"
                      className="voice-create__cancel"
                      onClick={() => {
                        setCreatingVoice(false);
                        setVoiceTitle("");
                      }}
                    >
                      Отмена
                    </button>
                  </div>
                </form>
              )}

              {(activeGuild.voiceChannels || []).length === 0 ? (
                <p className="sidebar__meta-line">Пока нет голосовых каналов</p>
              ) : (
                (activeGuild.voiceChannels || []).map((channel) => {
                  const joined = activeVoiceChannelId === channel.id;
                  const isGeneralVoice = channel.id.endsWith("::voice_general");
                  const canDeleteVoice =
                    Boolean(onDeleteVoiceChannel) &&
                    activeGuild.createdBy === currentUserId &&
                    !isGeneralVoice &&
                    (activeGuild.voiceChannels || []).length > 1;
                  return (
                    <div key={channel.id} className="voice-channel">
                      <div className="voice-channel__row">
                        <button
                          type="button"
                          className={`channel-item channel-item--voice ${
                            joined ? "is-active" : ""
                          }`}
                          disabled={voiceJoining}
                          onClick={() =>
                            onJoinVoice?.(
                              channel.id,
                              activeGuild.id,
                              channel.title,
                            )
                          }
                        >
                          <IconVolume size={16} />
                          <span>{channel.title}</span>
                          {channel.users.length > 0 && (
                            <em>{channel.users.length}</em>
                          )}
                        </button>
                        {canDeleteVoice && (
                          <button
                            type="button"
                            className="voice-channel__delete"
                            aria-label={`Удалить ${channel.title}`}
                            title="Удалить канал"
                            onClick={() =>
                              setPendingVoiceDelete({
                                groupId: activeGuild.id,
                                channelId: channel.id,
                                title: channel.title,
                              })
                            }
                          >
                            <IconTrash size={14} />
                          </button>
                        )}
                      </div>
                      {channel.users.length > 0 && (
                        <ul className="voice-channel__users">
                          {channel.users.map((user) => {
                            const person = peopleById.get(user.userId);
                            const avatarUrl =
                              user.avatarUrl || person?.avatarUrl;
                            return (
                              <li
                                key={user.userId}
                                className={`voice-user ${
                                  user.speaking ? "is-speaking" : ""
                                } ${user.muted ? "is-muted" : ""} ${
                                  user.deafened ? "is-deafened" : ""
                                }`}
                              >
                                <span className="voice-user__avatar">
                                  <Avatar
                                    name={user.name}
                                    src={avatarUrl}
                                    size="sm"
                                  />
                                </span>
                                <span className="voice-user__name">
                                  {user.name}
                                </span>
                                <span className="voice-user__flags" aria-hidden>
                                  {user.muted ? (
                                    <IconMicOff size={12} />
                                  ) : null}
                                  {user.deafened ? (
                                    <IconHeadphones size={12} />
                                  ) : null}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}

              <p className="sidebar__section">Пригласить</p>
              {onInviteToGroup ? (
                <>
                  <label className="sidebar__member-search">
                    <IconSearch size={14} />
                    <input
                      value={inviteQuery}
                      onChange={(event) => setInviteQuery(event.target.value)}
                      placeholder="Имя или логин…"
                      aria-label="Пригласить в группу"
                      autoComplete="off"
                    />
                  </label>
                  {inviteQuery.trim().length < 1 ? (
                    <p className="sidebar__meta-line">
                      Введите имя или логин — приглашение уйдёт в ЛС
                    </p>
                  ) : inviteCandidates.length === 0 ? (
                    <p className="sidebar__meta-line">Никого не нашли</p>
                  ) : (
                    <div className="sidebar__invite-list">
                      {inviteCandidates.map((user) => {
                        const name = user.displayName || user.username;
                        return (
                          <button
                            key={user.id}
                            type="button"
                            className="member-pick"
                            onClick={() => {
                              onInviteToGroup(activeGuild.id, user.id);
                              setInviteQuery("");
                              setInviteHits([]);
                            }}
                          >
                            <span className="person-item__avatar">
                              <Avatar name={name} src={user.avatarUrl} size="md" />
                            </span>
                            <span className="person-item__meta">
                              <strong>{name}</strong>
                              <em>@{user.username}</em>
                            </span>
                            <span className="member-pick__mark" aria-hidden>
                              <IconUserPlus size={15} />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : null}

              <p className="sidebar__section">Участники</p>
              <p className="sidebar__meta-line">
                {activeGuild.members} · онлайн {activeGuild.online}
              </p>
            </div>
          )}

          {focus === "home" && (
            <div className="sidebar__list">
              {dms.length === 0 ? (
                <div className="sidebar__empty">
                  <p>
                    {query.trim()
                      ? `Ничего не найдено по «${query.trim()}»`
                      : "Пока нет диалогов"}
                  </p>
                  <div className="sidebar__empty-actions">
                    <button
                      type="button"
                      className="sidebar__empty-clear"
                      onClick={() => onFocusChange("dms")}
                    >
                      Найти человека
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="sidebar__section">Диалоги</p>
                  {dms.map((chat) => (
                    <ChatRow
                      key={chat.id}
                      chat={chat}
                      active={chat.id === currentChatId}
                      muted={mutedIds.has(chat.id)}
                      avatarUrl={
                        chat.peerId
                          ? peopleById.get(chat.peerId)?.avatarUrl
                          : chat.avatarUrl
                      }
                      online={
                        chat.peerId
                          ? peopleById.get(chat.peerId)?.online
                          : undefined
                      }
                      onClick={() => onOpenChat(chat.id)}
                      onToggleMute={onToggleMute}
                    />
                  ))}
                </>
              )}
            </div>
          )}

          {focus === "dms" && (
            <div className="sidebar__list">
              <p className="sidebar__section">Кому написать</p>
              {others.length === 0 ? (
                <p className="sidebar__empty">
                  {query.trim()
                    ? "Никого не найдено"
                    : "Пока некого предложить — попробуйте поиск по имени."}
                </p>
              ) : (
                others.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    className="person-item"
                    onClick={() => onOpenDm(user.id)}
                  >
                    <span className="person-item__avatar">
                      <Avatar
                        name={user.displayName || user.username}
                        src={user.avatarUrl}
                        size="md"
                        online={user.online}
                      />
                    </span>
                    <span className="person-item__meta">
                      <strong>{user.displayName || user.username}</strong>
                      <em>
                        @{user.username}
                        {user.online ? " · в сети" : ""}
                      </em>
                    </span>
                  </button>
                ))
              )}

              <p className="sidebar__section">Открытые группы</p>
              {groupHits.length === 0 ? (
                <p className="sidebar__empty">
                  {query.trim()
                    ? "Открытых групп не найдено"
                    : "Пока нет открытых групп — создайте первую."}
                </p>
              ) : (
                groupHits.map((group) => (
                  <div key={group.id} className="discover-group">
                    <button
                      type="button"
                      className="discover-group__main"
                      onClick={() => {
                        if (group.joined) onOpenChat(group.id);
                      }}
                      disabled={!group.joined}
                    >
                      <Avatar
                        name={group.title}
                        src={group.avatarUrl}
                        size="md"
                      />
                      <span className="discover-group__meta">
                        <strong>{group.title}</strong>
                        <em>
                          {group.members} уч.
                          {group.topic ? ` · ${group.topic}` : ""}
                        </em>
                      </span>
                    </button>
                    {group.joined ? (
                      <button
                        type="button"
                        className="discover-group__action"
                        onClick={() => onOpenChat(group.id)}
                      >
                        Открыть
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="discover-group__action"
                        disabled={!onJoinGroup || joiningGroupId === group.id}
                        onClick={() => {
                          if (!onJoinGroup) return;
                          setJoiningGroupId(group.id);
                          void onJoinGroup(group.id)
                            .then((result) => {
                              if (!result.ok) return;
                              setGroupHits((prev) =>
                                prev.map((item) =>
                                  item.id === group.id
                                    ? {
                                        ...item,
                                        joined: true,
                                        members: item.joined
                                          ? item.members
                                          : item.members + 1,
                                      }
                                    : item,
                                ),
                              );
                            })
                            .finally(() => setJoiningGroupId(null));
                        }}
                      >
                        {joiningGroupId === group.id ? "…" : "Присоединиться"}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {focus === "create" && (
            <form className="sidebar__create" onSubmit={handleCreateGroup}>
              <label className="field">
                <span>Название</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Друзья"
                  maxLength={40}
                  required
                />
              </label>
              <label className="field">
                <span>Описание</span>
                <input
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder="О чём чат"
                  maxLength={120}
                />
              </label>
              <fieldset className="sidebar__visibility">
                <legend>Доступ</legend>
                <label className="sidebar__visibility-option">
                  <input
                    type="radio"
                    name="group-visibility"
                    checked={visibility === "public"}
                    onChange={() => setVisibility("public")}
                  />
                  <span>
                    <strong>Открытая</strong>
                    <em>Любой найдёт и вступит</em>
                  </span>
                </label>
                <label className="sidebar__visibility-option">
                  <input
                    type="radio"
                    name="group-visibility"
                    checked={visibility === "private"}
                    onChange={() => setVisibility("private")}
                  />
                  <span>
                    <strong>Закрытая</strong>
                    <em>Только по приглашению в ЛС</em>
                  </span>
                </label>
              </fieldset>
              <p className="sidebar__hint">
                {visibility === "public"
                  ? "Группа появится в поиске у всех. Закрытые — только по приглашению."
                  : "Закрытую группу не видно в поиске — приглашайте людей через ЛС."}
              </p>
              <button type="submit" disabled={!title.trim() || creatingGroup}>
                {creatingGroup ? "Создание…" : "Создать группу"}
              </button>
            </form>
          )}
        </motion.div>
      </AnimatePresence>

      <ConfirmDialog
        open={Boolean(pendingVoiceDelete)}
        title="Удалить голосовой канал?"
        body={
          pendingVoiceDelete
            ? `Канал «${pendingVoiceDelete.title}» будет удалён для всех.`
            : undefined
        }
        confirmLabel="Удалить"
        onCancel={() => setPendingVoiceDelete(null)}
        onConfirm={() => {
          if (!pendingVoiceDelete) return;
          onDeleteVoiceChannel?.(
            pendingVoiceDelete.groupId,
            pendingVoiceDelete.channelId,
          );
          setPendingVoiceDelete(null);
        }}
      />
    </aside>
  );
}
