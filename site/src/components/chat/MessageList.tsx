"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { AuthAccount, ChatMessage, PeopleUser } from "@/lib/types";
import { Avatar } from "@/components/chat/Avatar";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { formatDayChip } from "@/lib/dates";
import { isMediaAttachment, messageAttachments } from "@/lib/files";
import { soloEmojiSizePx } from "@/lib/emojiText";

type MessageListProps = {
  chatId: string;
  messages: ChatMessage[];
  people: PeopleUser[];
  account: AuthAccount;
  othersTyping: string[];
  searchQuery?: string;
  activeMatchId?: string | null;
  loading?: boolean;
  unreadAtOpen?: number;
  onReply?: (message: ChatMessage) => void;
  onOpenImage?: (src: string, name: string, kind?: "image" | "video") => void;
  onReact?: (messageId: string, emoji: string) => void;
  onJumpTo?: (messageId: string) => void;
  onCopied?: () => void;
  onRetry?: (messageId: string) => void;
  onCancelUpload?: (messageId: string) => void;
  onDiscard?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (message: ChatMessage) => void;
  onForward?: (message: ChatMessage) => void;
  onInviteRespond?: (messageId: string, accept: boolean) => void;
  onTranscribe?: (messageId: string) => void;
  /** Клик по стикеру → открыть пак, из которого он был отправлен. */
  onOpenStickerPack?: (packId: string, stickerId: string) => void;
  onMarkRead?: () => void;
  peerReadAt?: number | null;
  canModerate?: boolean;
  /** Wide side chat: own messages sit on the left and keep an avatar. */
  showOwnAvatar?: boolean;
};

function sameDay(a: number, b: number) {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function isChatMessage(message: ChatMessage) {
  return message.kind !== "system" && message.kind !== "call";
}

function isPlaqueMessage(message: ChatMessage) {
  return (
    message.kind !== "system" &&
    message.kind !== "call" &&
    message.kind !== "invite"
  );
}

function plaqueAuthor(
  message: ChatMessage,
  peopleById: Map<string, PeopleUser>,
  account?: AuthAccount,
) {
  if (account && message.authorId === account.userId) {
    return {
      name: account.displayName || account.username,
      avatarUrl: account.avatarUrl,
    };
  }
  const byId = message.authorId ? peopleById.get(message.authorId) : undefined;
  if (byId) {
    return {
      name: byId.displayName || byId.username,
      avatarUrl: byId.avatarUrl,
    };
  }
  return { name: message.author, avatarUrl: undefined as string | undefined };
}

/** Same author, < 5 min, same day — tdesktop isAttachedToPrevious / isAttachedToNext.
 *  Stickers / photos / GIF / emoji stay in one stack for the whole day. */
function attachedInCluster(a: ChatMessage, b: ChatMessage) {
  if (!isChatMessage(a) || !isChatMessage(b) || !sameAuthor(a, b)) return false;
  if (!sameDay(a.createdAt, b.createdAt)) return false;
  if (Math.abs(b.createdAt - a.createdAt) < 5 * 60 * 1000) return true;
  return isVisualMedia(a) && isVisualMedia(b);
}

function isMine(message: ChatMessage, account: AuthAccount) {
  if (message.authorId) return message.authorId === account.userId;
  const selfName = account.displayName || account.username;
  return (
    message.author.toLowerCase() === account.username.toLowerCase() ||
    message.author.toLowerCase() === selfName.toLowerCase()
  );
}

function sameAuthor(a: ChatMessage, b: ChatMessage) {
  if (a.authorId && b.authorId) return a.authorId === b.authorId;
  return a.author.toLowerCase() === b.author.toLowerCase();
}

/** Stickers, photos, video, GIF, and lone emoji stack like Telegram media. */
function isVisualMedia(message: ChatMessage) {
  if (message.kind === "sticker") return true;
  if (message.kind === "file") {
    return messageAttachments(message).some((file) => isMediaAttachment(file));
  }
  if (
    message.kind === "system" ||
    message.kind === "call" ||
    message.kind === "invite"
  ) {
    return false;
  }
  return soloEmojiSizePx(message.text) > 0;
}

function messageMatches(message: ChatMessage, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (message.kind === "system" || message.kind === "call") return false;
  return (
    message.text.toLowerCase().includes(q) ||
    message.author.toLowerCase().includes(q) ||
    Boolean(message.file?.name.toLowerCase().includes(q))
  );
}

function messageKey(message: ChatMessage) {
  return message.clientKey || message.id || `${message.room}-${message.createdAt}`;
}

export function MessageList({
  chatId,
  messages,
  people,
  account,
  othersTyping,
  searchQuery = "",
  activeMatchId = null,
  loading = false,
  unreadAtOpen = 0,
  onReply,
  onOpenImage,
  onReact,
  onJumpTo,
  onCopied,
  onRetry,
  onCancelUpload,
  onDiscard,
  onDelete,
  onEdit,
  onForward,
  onInviteRespond,
  onTranscribe,
  onOpenStickerPack,
  onMarkRead,
  peerReadAt = null,
  canModerate = false,
  showOwnAvatar = false,
}: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const jumpingRef = useRef(false);
  const firstRender = useRef(true);
  const prevCountRef = useRef(messages.length);
  const prevTailKeyRef = useRef<string | null>(null);
  const seenChatIdRef = useRef(chatId);
  const enteredKeysRef = useRef(new Set<string>());
  const [showJump, setShowJump] = useState(false);
  const [pendingNew, setPendingNew] = useState(0);
  const [showUnreadMark, setShowUnreadMark] = useState(unreadAtOpen > 0);

  const peopleAuthorKey = useMemo(
    () =>
      people
        .map(
          (user) =>
            `${user.id}\0${user.displayName}\0${user.username}\0${user.avatarUrl || ""}\0${user.bio || ""}`,
        )
        .join("|"),
    [people],
  );

  const peopleById = useMemo(() => {
    const map = new Map<string, PeopleUser>();
    for (const user of people) map.set(user.id, user);
    map.set(account.userId, {
      id: account.userId,
      username: account.username,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      bio: account.bio,
      online: true,
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peopleAuthorKey, account]);

  const firstUnreadIndex = useMemo(() => {
    if (!showUnreadMark || unreadAtOpen <= 0) return -1;
    let remaining = unreadAtOpen;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.kind === "system" || message.kind === "call") continue;
      if (isMine(message, account)) continue;
      remaining -= 1;
      if (remaining <= 0) return index;
    }
    return -1;
  }, [account, messages, showUnreadMark, unreadAtOpen]);

  const items = useMemo(() => {
    const searching = Boolean(searchQuery.trim());
    return messages.map((message, index) => {
      const prev = messages[index - 1];
      const next = messages[index + 1];
      const showDay = !prev || !sameDay(prev.createdAt, message.createdAt);
      const clustered = !!prev && attachedInCluster(prev, message);
      const attachedToNext = !!next && attachedInCluster(message, next);
      const match = messageMatches(message, searchQuery);
      const key = messageKey(message);
      const isNewest = index === messages.length - 1;
      const shouldAnimate =
        isNewest &&
        !searchQuery &&
        !firstRender.current &&
        !enteredKeysRef.current.has(key);

      const media = isVisualMedia(message);
      const prevMedia =
        !!prev &&
        isVisualMedia(prev) &&
        sameAuthor(prev, message) &&
        !showDay;

      return {
        key,
        message,
        showDay,
        showMeta: !clustered,
        showAvatar: isChatMessage(message) && !attachedToNext,
        attachPrev: clustered,
        attachNext: attachedToNext,
        mine: isMine(message, account),
        dimmed: searching && !match,
        highlighted: activeMatchId === message.id,
        showUnread: index === firstUnreadIndex,
        animate: shouldAnimate,
        media,
        mediaStack: Boolean(media && prevMedia),
      };
    });
  }, [account, activeMatchId, firstUnreadIndex, messages, searchQuery]);

  type ListItem = (typeof items)[number];
  type ListSegment =
    | { type: "day"; key: string; label: string }
    | { type: "single"; key: string; item: ListItem }
    | {
        type: "group";
        key: string;
        items: ListItem[];
        author: { name: string; avatarUrl?: string };
      };

  const segments = useMemo(() => {
    const out: ListSegment[] = [];
    let group: Extract<ListSegment, { type: "group" }> | null = null;

    function flush() {
      if (group) out.push(group);
      group = null;
    }

    for (const item of items) {
      if (item.showDay) {
        flush();
        out.push({
          type: "day",
          key: `day-${item.key}`,
          label: formatDayChip(item.message.createdAt),
        });
      }
      if (!isPlaqueMessage(item.message)) {
        flush();
        out.push({ type: "single", key: item.key, item });
        continue;
      }
      if (group && item.attachPrev) {
        group.items.push(item);
        group.author = plaqueAuthor(item.message, peopleById, account);
        continue;
      }
      flush();
      group = {
        type: "group",
        key: `g-${item.key}`,
        items: [item],
        author: plaqueAuthor(item.message, peopleById, account),
      };
    }
    flush();
    return out;
  }, [account, items, peopleById]);

  useEffect(() => {
    setShowUnreadMark(unreadAtOpen > 0);
  }, [chatId, unreadAtOpen]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;

    function onScroll() {
      const el = scrollerRef.current;
      if (!el) return;
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      // Smooth "jump to bottom" passes through far positions — don't unpin mid-flight.
      if (jumpingRef.current) {
        if (!near) return;
        jumpingRef.current = false;
      }
      nearBottomRef.current = near;
      setShowJump(!near);
      if (near) {
        setPendingNew(0);
        setShowUnreadMark(false);
        onMarkRead?.();
      }
    }

    // Media grows the list after it decodes; stay pinned if we were at the bottom.
    function onMediaLoad() {
      const el = scrollerRef.current;
      // Side-chat width drag reflows every bubble. Pinning here fights the
      // scroll lock and forces a layout of the whole thread on each move.
      if (!el || el.dataset.lockScroll || el.closest(".is-side-resizing")) return;
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
    }

    function cancelJump() {
      jumpingRef.current = false;
    }

    // Anything that changes height without a scroll event (waveforms, previews,
    // reactions, entry animations, composer/keyboard resizing the viewport).
    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(onMediaLoad) : null;
    const observeChildren = () => {
      if (!resizeObserver) return;
      resizeObserver.disconnect();
      resizeObserver.observe(node);
      for (const child of Array.from(node.children)) resizeObserver.observe(child);
    };
    const mutationObserver = resizeObserver ? new MutationObserver(observeChildren) : null;
    observeChildren();
    mutationObserver?.observe(node, { childList: true });

    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("load", onMediaLoad, true);
    node.addEventListener("loadedmetadata", onMediaLoad, true);
    node.addEventListener("wheel", cancelJump, { passive: true });
    node.addEventListener("touchstart", cancelJump, { passive: true });
    onScroll();
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("load", onMediaLoad, true);
      node.removeEventListener("loadedmetadata", onMediaLoad, true);
      node.removeEventListener("wheel", cancelJump);
      node.removeEventListener("touchstart", cancelJump);
    };
  }, [onMarkRead]);

  function stickToBottom() {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el && nearBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  useEffect(() => {
    if (seenChatIdRef.current !== chatId) {
      seenChatIdRef.current = chatId;
      firstRender.current = true;
      prevCountRef.current = 0;
      prevTailKeyRef.current = null;
      nearBottomRef.current = true;
      enteredKeysRef.current = new Set();
      setPendingNew(0);
      setShowJump(false);
    }

    const node = scrollerRef.current;
    if (!node || loading) return;

    const newest = messages[messages.length - 1];
    const tailKey = newest ? messageKey(newest) : null;

    if (firstRender.current) {
      for (const message of messages) {
        enteredKeysRef.current.add(messageKey(message));
      }
      if (firstUnreadIndex > 0) {
        const target = document.getElementById(
          `msg-${messages[firstUnreadIndex]?.id}`,
        );
        target?.scrollIntoView({ block: "center" });
      } else {
        stickToBottom();
      }
      firstRender.current = false;
      nearBottomRef.current = firstUnreadIndex <= 0;
      prevCountRef.current = messages.length;
      prevTailKeyRef.current = tailKey;
      setShowJump(firstUnreadIndex > 0);
      setPendingNew(0);
      return;
    }

    const prevCount = prevCountRef.current;
    const grewBy = Math.max(0, messages.length - prevCount);
    const tailChanged = Boolean(tailKey) && tailKey !== prevTailKeyRef.current;
    prevCountRef.current = messages.length;
    prevTailKeyRef.current = tailKey;

    if (newest) enteredKeysRef.current.add(messageKey(newest));

    if (searchQuery.trim() || activeMatchId) return;

    if (grewBy === 0 && !tailChanged) return;

    const newestIsMine = Boolean(newest && isMine(newest, account));

    if (!nearBottomRef.current && !newestIsMine) {
      if (grewBy > 0) {
        setPendingNew((count) => count + grewBy);
        setShowJump(true);
      }
      return;
    }

    nearBottomRef.current = true;
    setPendingNew(0);
    setShowJump(false);
    stickToBottom();
  }, [
    account,
    chatId,
    messages,
    searchQuery,
    activeMatchId,
    loading,
    firstUnreadIndex,
  ]);

  useEffect(() => {
    if (!activeMatchId) return;
    const el = document.getElementById(`msg-${activeMatchId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeMatchId]);

  function jumpBottom() {
    const node = scrollerRef.current;
    if (!node) return;
    nearBottomRef.current = true;
    jumpingRef.current = true;
    setShowJump(false);
    setPendingNew(0);
    setShowUnreadMark(false);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }

  function renderItem(
    item: ListItem,
    opts?: { skipDay?: boolean; hideAvatarColumn?: boolean },
  ) {
    const {
      key,
      message,
      showDay,
      showMeta,
      showAvatar,
      attachPrev,
      attachNext,
      mine,
      dimmed,
      highlighted,
      showUnread,
      animate,
      media,
      mediaStack,
    } = item;
    return (
      <div
        key={key}
        className={`message-block${media ? " message-block--media" : ""}${mediaStack ? " message-block--media-stack" : ""}`}
      >
        {!opts?.skipDay && showDay && (
          <p className="day-chip">{formatDayChip(message.createdAt)}</p>
        )}
        {showUnread && (
          <p className="unread-sep" role="separator">
            Новые сообщения
          </p>
        )}
        <MessageBubble
          message={message}
          mine={mine}
          peopleById={peopleById}
          showMeta={showMeta}
          showAvatar={showAvatar}
          hideAvatarColumn={(mine && !showOwnAvatar) || opts?.hideAvatarColumn}
          attachPrev={attachPrev}
          attachNext={attachNext}
          animate={animate}
          selfId={account.userId}
          searchQuery={searchQuery}
          dimmed={dimmed}
          highlighted={highlighted}
          peerReadAt={peerReadAt}
          onReply={onReply}
          onOpenImage={onOpenImage}
          onReact={onReact}
          onJumpTo={onJumpTo}
          onCopied={onCopied}
          onRetry={onRetry}
          onCancelUpload={onCancelUpload}
          onDiscard={onDiscard}
          onDelete={onDelete}
          onEdit={onEdit}
          onForward={onForward}
          onInviteRespond={onInviteRespond}
          onTranscribe={onTranscribe}
          onOpenStickerPack={onOpenStickerPack}
          canEdit={mine}
          canForward
          canDelete={
            (mine || canModerate) &&
            message.kind !== "system" &&
            message.kind !== "call" &&
            message.kind !== "invite" &&
            message.kind !== "sticker" &&
            message.status !== "pending" &&
            message.status !== "failed"
          }
        />
      </div>
    );
  }

  return (
    <div className="room__messages-wrap">
      <div className="room__messages" ref={scrollerRef}>
        {loading ? (
          <div className="msg-skeleton" aria-hidden>
            <div className="msg-skeleton__row">
              <i />
              <span />
            </div>
            <div className="msg-skeleton__row msg-skeleton__row--mine">
              <span />
            </div>
            <div className="msg-skeleton__row">
              <i />
              <span />
            </div>
            <div className="msg-skeleton__row msg-skeleton__row--mine">
              <span />
            </div>
            <div className="msg-skeleton__row">
              <i />
              <span />
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="room__empty room__empty--thread">
            <p className="room__empty-brand">Майко</p>
            <p className="room__empty-copy">Напишите первое сообщение</p>
          </div>
        ) : (
          <>
            <div className="room__messages-anchor" aria-hidden />
            {segments.map((segment) => {
              if (segment.type === "day") {
                return (
                  <p key={segment.key} className="day-chip">
                    {segment.label}
                  </p>
                );
              }
              if (segment.type === "single") {
                return renderItem(segment.item, { skipDay: true });
              }
              const mine = segment.items[0]?.mine ?? false;
              return (
                <div
                  key={segment.key}
                  className={`bubble-group ${mine ? "bubble-group--mine" : ""}`}
                >
                  {!mine || showOwnAvatar ? (
                    <div className="bubble-group__rail">
                      <div className="bubble-group__avatar">
                        <Avatar
                          name={segment.author.name}
                          src={segment.author.avatarUrl}
                          size="md"
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="bubble-group__body">
                    {segment.items.map((item) =>
                      renderItem(item, {
                        skipDay: true,
                        hideAvatarColumn: true,
                      }),
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
        <TypingIndicator names={othersTyping} />
      </div>

      {showJump && !loading && (
        <button
          type="button"
          className={`room__jump ${pendingNew > 0 ? "has-new" : ""}`}
          onClick={jumpBottom}
          aria-label={
            pendingNew > 0 ? "К новым сообщениям" : "Прокрутить вниз"
          }
        >
          {pendingNew > 0 ? "К новым" : "Вниз"}
          {pendingNew > 0 && (
            <span className="room__jump-count">
              {pendingNew > 99 ? "99+" : pendingNew}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
