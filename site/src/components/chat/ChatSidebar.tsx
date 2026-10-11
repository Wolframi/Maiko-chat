"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  Fragment,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import type {
  ChatInfo,
  GroupVisibility,
  PeopleUser,
  PublicGroupHit,
  VoiceChannelUser,
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
import { bareMediaUrl, signedMediaSrc } from "@/lib/files";
import { isChatMuted } from "@/lib/mute";
import { easeOutSoft, panelVariants } from "@/lib/motion";
import type { RailFocus } from "@/components/chat/ServerRail";

type ChatSidebarProps = {
  chats: ChatInfo[];
  people: PeopleUser[];
  currentUserId?: string;
  currentUserName?: string;
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
  onCreateTextChannel?: (groupId: string, title: string) => void;
  onDeleteTextChannel?: (groupId: string, channelId: string) => void;
  showCallMembers?: boolean;
  compactMembers?: ReactNode;
};

const CHANNEL_REVEAL = 38;

function ChannelSwipe({
  open,
  onOpen,
  onClose,
  onDelete,
  children,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const [shift, setShift] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; origin: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const limitRef = useRef(CHANNEL_REVEAL);

  const revealLimit = () => {
    const height = rootRef.current?.getBoundingClientRect().height ?? 0;
    if (height > 0) limitRef.current = height;
    return limitRef.current;
  };

  useEffect(() => {
    if (dragging) return;
    setShift(open ? -revealLimit() : 0);
  }, [open, dragging]);

  const finishDrag = (clientX: number) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag) return;
    const dx = clientX - drag.startX;
    if (Math.abs(dx) <= 6) {
      if (open) onClose();
      else onOpen();
      return;
    }
    const limit = revealLimit();
    const next = Math.min(0, Math.max(-limit, drag.origin + dx));
    if (next <= -limit * 0.4) onOpen();
    else onClose();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const limit = revealLimit();
    dragRef.current = {
      startX: event.clientX,
      origin: open ? -limit : 0,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Указатель уже отпущен — сдвиг всё равно считается по move/up.
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    if (Math.abs(dx) < 3) return;
    if (!dragging) setDragging(true);
    const next = Math.min(0, Math.max(-limitRef.current, drag.origin + dx));
    setShift(next);
  };

  const reveal = -shift;
  const faceStyle = {
    clipPath: `inset(0 ${reveal}px 0 0)`,
    "--channel-reveal": `${reveal}px`,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`channel-swipe${open ? " is-open" : ""}${dragging ? " is-dragging" : ""}`}
    >
      <button
        type="button"
        className="channel-swipe__delete"
        aria-label="Удалить"
        title="Удалить"
        aria-hidden={open ? undefined : true}
        tabIndex={open ? 0 : -1}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <IconTrash size={16} />
      </button>
      <div
        className={`channel-swipe__face${dragging ? " is-dragging" : ""}`}
        style={faceStyle}
      >
        {children}
      </div>
      <button
        type="button"
        className="channel-swipe__tab"
        style={{ transform: `translateX(${shift}px)` }}
        aria-label={open ? "Скрыть удаление" : "Показать удаление"}
        title={open ? "Скрыть" : "Потянуть"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finishDrag(event.clientX)}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
          setShift(open ? -revealLimit() : 0);
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span />
      </button>
    </div>
  );
}

function matchesQuery(value: string, query: string) {
  return value.toLowerCase().includes(query.toLowerCase());
}

function PreviewThumb({
  url,
  animated,
  sticker,
}: {
  url: string;
  animated?: boolean;
  sticker?: boolean;
}) {
  const src = signedMediaSrc(url);
  if (!src) return null;
  const className = `room-item__thumb${sticker ? " is-sticker" : ""}`;
  const video =
    Boolean(animated) && /\.(webm|mp4|mov)$/i.test(bareMediaUrl(url));
  if (video) {
    return (
      <video
        className={className}
        src={src}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
      />
    );
  }
  return <img className={className} src={src} alt="" draggable={false} />;
}

function chatRowPreview(
  chat: ChatInfo,
  currentUserId?: string,
  currentUserName?: string,
) {
  const last = chat.lastMessage;
  if (!last) {
    return {
      text: chat.topic,
      thumbUrl: undefined as string | undefined,
      thumbAnimated: undefined as boolean | undefined,
      sticker: false,
    };
  }
  const own =
    Boolean(last.authorId && currentUserId && last.authorId === currentUserId) ||
    Boolean(currentUserName && last.author === currentUserName);
  const text = last.text.trim();
  const media = {
    thumbUrl: last.thumbUrl,
    thumbAnimated: last.thumbAnimated,
    sticker: last.kind === "sticker",
  };
  if (own || chat.type === "dm") {
    return { text, ...media };
  }
  return {
    text: text ? `${last.author}: ${text}` : last.author,
    ...media,
  };
}

function ChatRow({
  chat,
  active,
  avatarUrl,
  muted,
  online,
  currentUserId,
  currentUserName,
  onClick,
  onToggleMute,
}: {
  chat: ChatInfo;
  active: boolean;
  avatarUrl?: string;
  muted?: boolean;
  online?: boolean;
  currentUserId?: string;
  currentUserName?: string;
  onClick: () => void;
  onToggleMute?: (chatId: string) => void;
}) {
  const title = chat.type === "channel" ? `#${chat.title}` : chat.title;
  const preview = chatRowPreview(chat, currentUserId, currentUserName);
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
            <span className="room-item__preview">
              {preview.thumbUrl ? (
                <PreviewThumb
                  url={preview.thumbUrl}
                  animated={preview.thumbAnimated}
                  sticker={preview.sticker}
                />
              ) : null}
              <span className="room-item__preview-text">{preview.text}</span>
            </span>
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
  currentUserName,
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
  onCreateTextChannel,
  onDeleteTextChannel,
  showCallMembers = false,
  compactMembers,
}: ChatSidebarProps) {
  const localSearchRef = useRef<HTMLInputElement>(null);
  const [revealedChannelId, setRevealedChannelId] = useState<string | null>(
    null,
  );
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
  const [textTitle, setTextTitle] = useState("");
  const [creatingText, setCreatingText] = useState(false);
  const [pendingTextDelete, setPendingTextDelete] = useState<{
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

  const guildMembers = useMemo(() => {
    if (!activeGuild) return [];
    const ids = new Set(activeGuild.memberIds || []);
    return people
      .filter((user) => ids.has(user.id))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (a.displayName || a.username).localeCompare(
          b.displayName || b.username,
          "ru",
        );
      });
  }, [activeGuild, people]);

  const pinGuildBottom = showCallMembers;
  const guildListRef = useRef<HTMLDivElement>(null);
  const guildSplitRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const [guildTopHeight, setGuildTopHeight] = useState<number | null>(null);
  const [guildSplitting, setGuildSplitting] = useState(false);
  const guildSplitKey = [
    activeGuild?.id,
    activeGuild?.textChannels?.length ?? 0,
    activeGuild?.voiceChannels?.length ?? 0,
    activeGuild?.voiceChannels?.reduce(
      (count, channel) => count + channel.users.length,
      0,
    ) ?? 0,
    guildMembers.length,
  ].join(":");

  const clampGuildTop = useCallback((height: number, list: HTMLElement) => {
    const handle = 10;
    const top = list.querySelector<HTMLElement>(".sidebar__guild-scroll");
    const listHeight = list.clientHeight;
    const roomAboveGreen = Math.max(0, listHeight - handle);
    if (!top) return Math.min(roomAboveGreen, Math.max(0, Math.round(height)));

    const contentTop = (el: HTMLElement) => {
      const pane = top.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return rect.top - pane.top + top.scrollTop;
    };
    const contentBottom = (el: HTMLElement) => {
      const pane = top.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return rect.bottom - pane.top + top.scrollTop;
    };

    const invite = top.querySelector<HTMLElement>("[data-guild-anchor='invite']");
    const textHead = top.querySelector<HTMLElement>(
      "[data-guild-anchor='text-channels']",
    );
    const users = top.querySelectorAll<HTMLElement>(".voice-user");
    const lastUser = users.length ? users[users.length - 1] : null;
    const inviteLimit = invite ? contentBottom(invite) : roomAboveGreen;
    const maxTop = Math.min(roomAboveGreen, Math.max(0, inviteLimit));

    let minTop = lastUser
      ? contentBottom(lastUser) + 6
      : invite
        ? contentTop(invite)
        : 0;

    const members = list.querySelectorAll<HTMLElement>(".sidebar__member");
    if (members.length && textHead) {
      const row = members[0].getBoundingClientRect().height || 34;
      const needed = members.length * row + 28;
      const bottomIfProtected = listHeight - handle - minTop;
      if (needed > bottomIfProtected + 1) {
        minTop = contentTop(textHead);
      }
    }

    const max = Math.max(0, maxTop);
    const min = Math.max(0, Math.min(minTop, max));
    return Math.min(max, Math.max(min, Math.round(height)));
  }, []);

  function handleGuildSplitDown(event: ReactPointerEvent<HTMLDivElement>) {
    const list = guildListRef.current;
    const top = event.currentTarget.previousElementSibling;
    if (!list || !(top instanceof HTMLElement)) return;
    event.preventDefault();
    guildSplitRef.current = {
      startY: event.clientY,
      startHeight: top.getBoundingClientRect().height,
    };
    setGuildSplitting(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleGuildSplitMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = guildSplitRef.current;
    const list = guildListRef.current;
    if (!drag || !list) return;
    setGuildTopHeight(
      clampGuildTop(drag.startHeight + event.clientY - drag.startY, list),
    );
  }

  function handleGuildSplitUp(event: ReactPointerEvent<HTMLDivElement>) {
    guildSplitRef.current = null;
    setGuildSplitting(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  useLayoutEffect(() => {
    if (!pinGuildBottom || guildTopHeight == null) return;
    const list = guildListRef.current;
    if (!list) return;
    const next = clampGuildTop(guildTopHeight, list);
    if (Math.abs(next - guildTopHeight) > 1) setGuildTopHeight(next);
  }, [pinGuildBottom, guildTopHeight, guildSplitKey, clampGuildTop]);

  function renderVoiceUser(user: VoiceChannelUser) {
    const person = peopleById.get(user.userId);
    const avatarUrl = user.avatarUrl || person?.avatarUrl;
    return (
      <li
        key={user.userId}
        className={`voice-user ${user.speaking ? "is-speaking" : ""} ${
          user.muted ? "is-muted" : ""
        } ${user.deafened ? "is-deafened" : ""}`}
      >
        <span className="voice-user__avatar">
          <Avatar name={user.name} src={avatarUrl} size="sm" />
        </span>
        <span className="voice-user__name">{user.name}</span>
        <span className="voice-user__flags" aria-hidden>
          {user.muted ? <IconMicOff size={12} /> : null}
          {user.deafened ? <IconHeadphones size={12} /> : null}
        </span>
      </li>
    );
  }

  useEffect(() => {
    if (!revealedChannelId) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".channel-swipe")) return;
      setRevealedChannelId(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [revealedChannelId]);

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
            <div
              ref={guildListRef}
              className={`sidebar__list sidebar__list--guild${
                pinGuildBottom ? " has-bottom" : ""
              }${guildSplitting ? " is-splitting" : ""}`}
            >
              <div
                className={
                  pinGuildBottom
                    ? `sidebar__guild-scroll${guildTopHeight == null ? "" : " is-resized"}`
                    : "sidebar__guild-flow"
                }
                style={
                  pinGuildBottom && guildTopHeight != null
                    ? { height: guildTopHeight }
                    : undefined
                }
              >
              <div className="sidebar__section-row" data-guild-anchor="text-channels">
                <p className="sidebar__section">Текстовые каналы</p>
                {onCreateTextChannel && (
                  <button
                    type="button"
                    className={`sidebar__section-add ${creatingText ? "is-open" : ""}`}
                    aria-label={creatingText ? "Отменить создание" : "Создать текстовый чат"}
                    title={creatingText ? "Отменить" : "Создать текстовый чат"}
                    onClick={() => {
                      setCreatingVoice(false);
                      setVoiceTitle("");
                      setCreatingText((open) => !open);
                      if (creatingText) setTextTitle("");
                    }}
                  >
                    {creatingText ? <IconClose size={14} /> : <IconPlus size={14} />}
                  </button>
                )}
              </div>
              {creatingText && onCreateTextChannel && (
                <form
                  className="voice-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = textTitle.trim();
                    if (!name) return;
                    onCreateTextChannel(activeGuild.id, name);
                    setTextTitle("");
                    setCreatingText(false);
                  }}
                >
                  <input
                    value={textTitle}
                    onChange={(event) => setTextTitle(event.target.value)}
                    placeholder="Название чата"
                    maxLength={40}
                    aria-label="Название текстового чата"
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
                        setCreatingText(false);
                        setTextTitle("");
                      }}
                    >
                      Отмена
                    </button>
                  </div>
                </form>
              )}
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
              {(activeGuild.textChannels || []).map((channel) => {
                const canDelete =
                  Boolean(onDeleteTextChannel) &&
                  activeGuild.createdBy === currentUserId;
                const item = (
                  <button
                    type="button"
                    className={`channel-item ${
                      currentChatId === channel.id ? "is-active" : ""
                    }`}
                    onClick={() => onOpenChat(channel.id)}
                  >
                    <IconHash size={16} />
                    <span>{channel.title}</span>
                    {channel.unreadCount > 0 && (
                      <em>
                        {channel.unreadCount > 99 ? "99+" : channel.unreadCount}
                      </em>
                    )}
                  </button>
                );
                if (!canDelete) return <Fragment key={channel.id}>{item}</Fragment>;
                return (
                  <ChannelSwipe
                    key={channel.id}
                    open={revealedChannelId === channel.id}
                    onOpen={() => setRevealedChannelId(channel.id)}
                    onClose={() => setRevealedChannelId(null)}
                    onDelete={() => {
                      setRevealedChannelId(null);
                      setPendingTextDelete({
                        groupId: activeGuild.id,
                        channelId: channel.id,
                        title: channel.title,
                      });
                    }}
                  >
                    {item}
                  </ChannelSwipe>
                );
              })}

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
                    !isGeneralVoice;
                  const voiceItem = (
                    <button
                      type="button"
                      className={`channel-item channel-item--voice ${
                        joined ? "is-active" : ""
                      }`}
                      disabled={voiceJoining && !activeVoiceChannelId}
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
                  );
                  return (
                    <div key={channel.id} className="voice-channel">
                      <div className="voice-channel__row">
                        {canDeleteVoice ? (
                          <ChannelSwipe
                            open={revealedChannelId === channel.id}
                            onOpen={() => setRevealedChannelId(channel.id)}
                            onClose={() => setRevealedChannelId(null)}
                            onDelete={() => {
                              setRevealedChannelId(null);
                              setPendingVoiceDelete({
                                groupId: activeGuild.id,
                                channelId: channel.id,
                                title: channel.title,
                              });
                            }}
                          >
                            {voiceItem}
                          </ChannelSwipe>
                        ) : (
                          voiceItem
                        )}
                      </div>
                      {channel.users.length > 0 && (
                        <ul className="voice-channel__users">
                          {channel.users.map((user) => renderVoiceUser(user))}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}

              <div data-guild-anchor="invite">
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
                  {inviteQuery.trim().length < 1 ? null : inviteCandidates.length === 0 ? (
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
              </div>
              </div>

              {pinGuildBottom ? (
                <div
                  className="sidebar__guild-split"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Изменить высоту каналов и участников"
                  aria-valuemin={0}
                  aria-valuenow={guildTopHeight ?? undefined}
                  tabIndex={0}
                  onPointerDown={handleGuildSplitDown}
                  onPointerMove={handleGuildSplitMove}
                  onPointerUp={handleGuildSplitUp}
                  onPointerCancel={handleGuildSplitUp}
                  onDoubleClick={() => setGuildTopHeight(null)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    const list = guildListRef.current;
                    const top = event.currentTarget.previousElementSibling;
                    if (!list || !(top instanceof HTMLElement)) return;
                    event.preventDefault();
                    const current = guildTopHeight ?? top.getBoundingClientRect().height;
                    setGuildTopHeight(
                      clampGuildTop(
                        current + (event.key === "ArrowDown" ? 24 : -24),
                        list,
                      ),
                    );
                  }}
                >
                  <span aria-hidden />
                </div>
              ) : null}

              {pinGuildBottom ? (
                <div className="sidebar__guild-bottom">
                  {showCallMembers ? (
                    <div className="sidebar__call-members">
                      <p className="sidebar__section">Участники</p>
                      <div className="sidebar__call-members-list">
                        {guildMembers.map((user) => {
                          const name = user.displayName || user.username;
                          return (
                            <button
                              key={user.id}
                              type="button"
                              className={`person-item sidebar__member ${
                                user.online ? "is-online" : "is-offline"
                              }`}
                              onClick={() => onOpenDm(user.id)}
                            >
                              <span className="person-item__avatar">
                                <Avatar
                                  name={name}
                                  src={user.avatarUrl}
                                  size="sm"
                                  online={user.online}
                                />
                              </span>
                              <span className="person-item__meta">
                                <strong>
                                  {name}
                                  {user.id === currentUserId ? " (вы)" : ""}
                                </strong>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <div className="sidebar__members-summary">
                    <p className="sidebar__section">Участники</p>
                    <p className="sidebar__meta-line">
                      {activeGuild.members} · онлайн {activeGuild.online}
                    </p>
                  </div>
                  {compactMembers && (
                    <div className="sidebar__responsive-members">
                      <p className="sidebar__section">Участники</p>
                      {compactMembers}
                    </div>
                  )}
                </>
              )}
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
                      currentUserId={currentUserId}
                      currentUserName={currentUserName}
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
        open={Boolean(pendingTextDelete)}
        title="Удалить текстовый чат?"
        body={
          pendingTextDelete
            ? `Чат «${pendingTextDelete.title}» будет удалён для всех. Основной general не затрагивается.`
            : undefined
        }
        confirmLabel="Удалить"
        onCancel={() => setPendingTextDelete(null)}
        onConfirm={() => {
          if (!pendingTextDelete) return;
          onDeleteTextChannel?.(
            pendingTextDelete.groupId,
            pendingTextDelete.channelId,
          );
          setPendingTextDelete(null);
        }}
      />

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
