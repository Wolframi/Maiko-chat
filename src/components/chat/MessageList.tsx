"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { AuthAccount, ChatMessage, PeopleUser } from "@/lib/types";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { formatDayChip } from "@/lib/dates";
import { isMediaAttachment, messageAttachments } from "@/lib/files";

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
  onDiscard?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (message: ChatMessage) => void;
  onForward?: (message: ChatMessage) => void;
  onInviteRespond?: (messageId: string, accept: boolean) => void;
  onMarkRead?: () => void;
  peerReadAt?: number | null;
  canModerate?: boolean;
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
  onDiscard,
  onDelete,
  onEdit,
  onForward,
  onInviteRespond,
  onMarkRead,
  peerReadAt = null,
  canModerate = false,
}: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
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
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peopleAuthorKey]);

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
      const showDay = !prev || !sameDay(prev.createdAt, message.createdAt);
      const system = message.kind === "system" || message.kind === "call";
      const clustered =
        !system &&
        !!prev &&
        prev.kind !== "system" &&
        prev.kind !== "call" &&
        sameAuthor(prev, message) &&
        message.createdAt - prev.createdAt < 5 * 60 * 1000 &&
        !showDay;
      const match = messageMatches(message, searchQuery);
      const key = messageKey(message);
      const isNewest = index === messages.length - 1;
      const shouldAnimate =
        isNewest &&
        !searchQuery &&
        !firstRender.current &&
        !enteredKeysRef.current.has(key);

      const media =
        message.kind === "file" &&
        messageAttachments(message).some((file) => isMediaAttachment(file));
      const prevMedia =
        !!prev &&
        prev.kind === "file" &&
        messageAttachments(prev).some((file) => isMediaAttachment(file)) &&
        sameAuthor(prev, message) &&
        !showDay;

      return {
        key,
        message,
        showDay,
        showMeta: !clustered,
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
      nearBottomRef.current = near;
      setShowJump(!near);
      if (near) {
        setPendingNew(0);
        setShowUnreadMark(false);
        onMarkRead?.();
      }
    }

    node.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => node.removeEventListener("scroll", onScroll);
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

    // Only auto-scroll when the thread actually grew / got a new tail.
    // Edits, reactions, and status updates must not yank the viewport.
    if (grewBy === 0 && !tailChanged) return;

    const newestIsMine = Boolean(newest && isMine(newest, account));

    // Own sends always pin to bottom; others only if already near bottom.
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
    setShowJump(false);
    setPendingNew(0);
    setShowUnreadMark(false);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
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
            <p className="room__empty-brand">Pulse</p>
            <p className="room__empty-copy">Напишите первое сообщение</p>
          </div>
        ) : (
          <>
            <div className="room__messages-anchor" aria-hidden />
            {items.map(
              ({
                key,
                message,
                showDay,
                showMeta,
                mine,
                dimmed,
                highlighted,
                showUnread,
                animate,
                media,
                mediaStack,
              }) => (
                <div
                  key={key}
                  className={`message-block${media ? " message-block--media" : ""}${mediaStack ? " message-block--media-stack" : ""}`}
                >
                  {showDay && (
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
                    onDiscard={onDiscard}
                    onDelete={onDelete}
                    onEdit={onEdit}
                    onForward={onForward}
                    onInviteRespond={onInviteRespond}
                    canEdit={mine}
                    canForward
                    canDelete={
                      (mine || canModerate) &&
                      message.kind !== "system" &&
                      message.kind !== "call" &&
                      message.kind !== "invite" &&
                      message.status !== "pending" &&
                      message.status !== "failed"
                    }
                  />
                </div>
              ),
            )}
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
