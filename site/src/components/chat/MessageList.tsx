"use client";

import { useEffect, useLayoutEffect, useMemo, useState, useRef, useCallback } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { AuthAccount, ChatMessage, PeopleUser } from "@/lib/types";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { ScrollAnchoredList } from "@/components/chat/ScrollAnchoredList";
import { formatDayChip } from "@/lib/dates";
import { isMediaAttachment, messageAttachments } from "@/lib/files";
import { soloEmojiSizePx } from "@/lib/emojiText";

type MessageListProps = {
  chatId: string;
  messages: ChatMessage[];
  historyVersion?: number;
  people: PeopleUser[];
  account: AuthAccount;
  othersTyping: string[];
  searchQuery?: string;
  activeMatchId?: string | null;
  loading?: boolean;
  hasMore?: boolean;
  hasNewer?: boolean;
  loadingOlder?: boolean;
  historyError?: string | null;
  onLoadOlder?: () => Promise<boolean>;
  onLoadNewer?: () => Promise<boolean>;
  onLoadLatest?: () => Promise<boolean>;
  jumpRequest?: { id: string; nonce: number } | null;
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

type ListContext = { names: string[]; hasMore: boolean; loadingOlder: boolean; preserveScroll: boolean; anchorKey: string; scrollRevision: { current: number }; historyError?: string | null; onLoadOlder?: () => Promise<boolean> };
function HistoryHeader({ context }: { context?: ListContext }) {
  if (!context?.hasMore) return null;
  return <div className="message-history-more"><button type="button" disabled={context.loadingOlder} onClick={() => void context.onLoadOlder?.()}>
    {context.loadingOlder ? "Загружаем сообщения…" : context.historyError || "Предыдущие сообщения"}
  </button></div>;
}
function HistoryFooter({ context }: { context?: ListContext }) {
  return <div className="message-history-footer">
    <TypingIndicator names={context?.names ?? []} />
  </div>;
}
const listComponents = { Header: HistoryHeader, Footer: HistoryFooter, List: ScrollAnchoredList };
const initialFirstItemIndex = 1_000_000_000;
const listOverscan = { main: 240, reverse: 120 };
const listViewport = { top: 400, bottom: 400 };

export function MessageList({
  chatId,
  messages,
  historyVersion = 0,
  people,
  account,
  othersTyping,
  searchQuery = "",
  activeMatchId = null,
  loading = false,
  hasMore = false,
  hasNewer = false,
  loadingOlder = false,
  historyError = null,
  onLoadOlder,
  onLoadNewer,
  onLoadLatest,
  jumpRequest = null,
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
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const viewportObserverRef = useRef<ResizeObserver | null>(null);
  const preparingPageRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const scrollRevisionRef = useRef(0);
  // Update data and its index in the same render so Virtuoso can prepend while
  // preserving its measured rows and the user's ongoing scroll movement.
  const listWindowRef = useRef({ chatId, historyVersion, messages, hasNewer, appendingHistory: false, prepending: false, firstItemIndex: initialFirstItemIndex });
  const listWindow = useMemo(() => {
    const previous = listWindowRef.current;
    if (previous.messages === messages && previous.chatId === chatId && previous.historyVersion === historyVersion && previous.hasNewer === hasNewer) return previous;
    let firstItemIndex = initialFirstItemIndex;
    let appendingHistory = false;
    let prepending = false;
    if (previous.chatId === chatId && previous.historyVersion === historyVersion) {
      const oldFirst = previous.messages[0];
      const newFirst = messages[0];
      const prepended = oldFirst ? messages.findIndex(message => messageKey(message) === messageKey(oldFirst)) : -1;
      const removed = newFirst ? previous.messages.findIndex(message => messageKey(message) === messageKey(newFirst)) : -1;
      if (prepended >= 0) firstItemIndex = previous.firstItemIndex - prepended;
      else if (removed >= 0) firstItemIndex = previous.firstItemIndex + removed;
      appendingHistory = previous.hasNewer && prepended === 0 && messages.length > previous.messages.length;
      prepending = prepended > 0;
    }
    return { chatId, historyVersion, messages, hasNewer, appendingHistory, prepending, firstItemIndex };
  }, [chatId, hasNewer, historyVersion, messages]);
  useLayoutEffect(() => { listWindowRef.current = listWindow; }, [listWindow]);
  const firstItemIndex = listWindow.firstItemIndex;
  const appliedJumpRef = useRef<number | null>(null);
  const appliedSearchRef = useRef("");
  const initialScrollReadyRef = useRef(false);
  const initialTargetRef = useRef<string | null | undefined>(undefined);
  const initialFrameRef = useRef(0);
  const tailRequestedRef = useRef(false);
  // Deferred row measurements must preserve explicit navigation until user input.
  const navigationTargetRef = useRef<string | null>(null);
  const nearBottomRef = useRef(true);
  const firstRender = useRef(true);
  const prevCountRef = useRef(messages.length);
  const prevTailKeyRef = useRef<string | null>(null);
  const previousHistoryRef = useRef({ version: historyVersion, hasNewer });
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
  useEffect(() => {
    setShowUnreadMark(unreadAtOpen > 0);
  }, [chatId, unreadAtOpen]);

  const unreadId = firstUnreadIndex >= 0 ? messages[firstUnreadIndex]?.id : null;

  const positionMessage = useCallback((index: number, id: string) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const row = document.getElementById(`msg-${id}`);
    if (row && scroller.contains(row)) {
      const rect = row.getBoundingClientRect();
      scroller.scrollTop += rect.top - bounds.top - (scroller.clientHeight - rect.height) / 2;
      return;
    }
    // Use the measured size tree to reveal an unmounted row. Unlike
    // scrollToIndex, this leaves no delayed retry that can override a wheel
    // gesture after navigation has already finished.
    virtuosoRef.current?.getState(({ ranges }) => {
      let offset = 0;
      let height = 0;
      for (const range of ranges) {
        if (range.startIndex > index) break;
        offset += Math.max(0, Math.min(index, range.endIndex + 1) - range.startIndex) * range.size;
        if (index <= range.endIndex) { height = range.size; break; }
      }
      const list = scroller.querySelector<HTMLElement>("[data-testid='virtuoso-item-list']");
      if (!list || !height) return;
      const start = list.getBoundingClientRect().top + scroller.scrollTop - bounds.top;
      scroller.scrollTop = start + offset - (scroller.clientHeight - height) / 2;
    });
  }, []);

  const settleInitialPosition = useCallback(() => {
    const target = navigationTargetRef.current;
    if (target) {
      const index = items.findIndex(item => item.message.id === target);
      if (index >= 0) positionMessage(index, target);
      return;
    }
    if (tailRequestedRef.current && items.length) {
      if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
      return;
    }
    if (initialScrollReadyRef.current || initialTargetRef.current === undefined) return;
    const id = initialTargetRef.current;
    const index = id ? items.findIndex(item => item.message.id === id) : -1;
    if (index >= 0 && id) positionMessage(index, id);
    else if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [items, positionMessage]);

  const settlePositionRef = useRef(settleInitialPosition);
  useLayoutEffect(() => { settlePositionRef.current = settleInitialPosition; }, [settleInitialPosition]);
  const scheduleInitialPosition = useCallback(() => {
    cancelAnimationFrame(initialFrameRef.current);
    if (initialScrollReadyRef.current && !navigationTargetRef.current && !tailRequestedRef.current) return;
    // Async navigation may finish after a replacement window has committed.
    // Always position using the current rows, rather than the caller's rows.
    initialFrameRef.current = requestAnimationFrame(() => settlePositionRef.current());
  }, []);

  const bindScroller = useCallback((element: HTMLElement | Window | null) => {
    viewportObserverRef.current?.disconnect();
    scrollerRef.current = element instanceof HTMLElement ? element : null;
    if (scrollerRef.current) {
      viewportObserverRef.current = new ResizeObserver(scheduleInitialPosition);
      viewportObserverRef.current.observe(scrollerRef.current);
    }
  }, [scheduleInitialPosition]);

  useLayoutEffect(() => {
    if (loading || !items.length) return;
    if (initialTargetRef.current === undefined) initialTargetRef.current = unreadId ?? null;
    scheduleInitialPosition();
    return () => cancelAnimationFrame(initialFrameRef.current);
  }, [loading, scheduleInitialPosition, settleInitialPosition, items.length, unreadId]);

  const loadOlder = useCallback(async () => {
    if (!onLoadOlder || loadingOlder || preparingPageRef.current || loadingNewerRef.current) return false;
    preparingPageRef.current = true;
    try {
      // startReached can fire before React commits the newly visible rows.
      // A fast response must not replace those rows before an anchor exists.
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const scroller = scrollerRef.current;
        if (!scroller) return false;
        const bounds = scroller.getBoundingClientRect();
        const visible = Array.from(scroller.querySelectorAll<HTMLElement>("[id^='msg-']"))
          .some(row => { const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom; });
        if (visible) break;
        if (attempt === 2) return false;
      }
      return await onLoadOlder();
    } finally {
      // Ignore boundary callbacks from the intermediate prepend measurements.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      preparingPageRef.current = false;
    }
  }, [loadingOlder, onLoadOlder]);

  const loadNewer = useCallback(async () => {
    if (!hasNewer || !onLoadNewer || loadingOlder || preparingPageRef.current || loadingNewerRef.current || !initialScrollReadyRef.current || navigationTargetRef.current) return;
    loadingNewerRef.current = true;
    try { await onLoadNewer(); }
    finally { loadingNewerRef.current = false; }
  }, [hasNewer, loadingOlder, onLoadNewer]);

  function scrollIntent() {
    scrollRevisionRef.current++;
    navigationTargetRef.current = null;
    initialScrollReadyRef.current = true;
    tailRequestedRef.current = false;
  }

  const onBottomChange = useCallback((atBottom: boolean) => {
    nearBottomRef.current = atBottom;
    setShowJump(!atBottom);
    if (atBottom && !hasNewer) {
      setPendingNew(0);
      setShowUnreadMark(false);
      onMarkRead?.();
    }
  }, [hasNewer, onMarkRead]);

  useEffect(() => {
    if (seenChatIdRef.current !== chatId) {
      seenChatIdRef.current = chatId;
      firstRender.current = true;
      prevCountRef.current = 0;
      prevTailKeyRef.current = null;
      enteredKeysRef.current = new Set();
      setPendingNew(0);
    }
    if (loading) return;
    const newest = messages[messages.length - 1];
    const tailKey = newest ? messageKey(newest) : null;
    const grewBy = Math.max(0, messages.length - prevCountRef.current);
    const appended = prevTailKeyRef.current !== null && tailKey !== prevTailKeyRef.current;
    const returnedToLatest = previousHistoryRef.current.hasNewer && !hasNewer && previousHistoryRef.current.version !== historyVersion;
    previousHistoryRef.current = { version: historyVersion, hasNewer };
    prevCountRef.current = messages.length;
    prevTailKeyRef.current = tailKey;
    if (firstRender.current) {
      for (const message of messages) enteredKeysRef.current.add(messageKey(message));
      firstRender.current = false;
      return;
    }
    if (newest) enteredKeysRef.current.add(messageKey(newest));
    if ((!appended && !returnedToLatest) || searchQuery.trim() || activeMatchId || hasNewer || listWindow.appendingHistory) return;
    if ((newest && isMine(newest, account)) || nearBottomRef.current) {
      navigationTargetRef.current = null;
      tailRequestedRef.current = true;
      scheduleInitialPosition();
    } else if (!nearBottomRef.current && grewBy > 0) {
      setPendingNew(count => count + grewBy);
    }
  }, [account, activeMatchId, chatId, hasNewer, historyVersion, listWindow.appendingHistory, loading, messages, scheduleInitialPosition, searchQuery]);

  useEffect(() => {
    const id = activeMatchId || jumpRequest?.id;
    if (!id) return;
    const searchKey = activeMatchId ? `${searchQuery}\0${activeMatchId}` : "";
    if (activeMatchId && appliedSearchRef.current === searchKey) return;
    if (!activeMatchId) {
      appliedSearchRef.current = "";
      if (!jumpRequest || appliedJumpRef.current === jumpRequest.nonce) return;
    }
    const index = items.findIndex(item => item.message.id === id);
    if (index < 0) return;
    initialScrollReadyRef.current = true;
    tailRequestedRef.current = false;
    navigationTargetRef.current = id;
    if (activeMatchId) appliedSearchRef.current = searchKey;
    else if (jumpRequest) appliedJumpRef.current = jumpRequest.nonce;
    let timer: ReturnType<typeof setTimeout> | undefined;
    positionMessage(index, id);
    scheduleInitialPosition();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const element = document.getElementById(`msg-${id}`);
        element?.classList.add("is-flash");
        timer = setTimeout(() => element?.classList.remove("is-flash"), 1200);
      });
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); document.getElementById(`msg-${id}`)?.classList.remove("is-flash"); };
  }, [activeMatchId, jumpRequest, searchQuery, items, positionMessage, scheduleInitialPosition]);

  async function jumpBottom() {
    navigationTargetRef.current = null;
    tailRequestedRef.current = true;
    if (hasNewer && !await onLoadLatest?.()) { tailRequestedRef.current = false; return; }
    setPendingNew(0);
    setShowUnreadMark(false);
    scheduleInitialPosition();
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
    <div className="room__messages-wrap" data-loaded-messages={messages.length}
      onWheelCapture={scrollIntent}
      onTouchStartCapture={scrollIntent}
      onTouchMoveCapture={scrollIntent}
      onPointerDownCapture={scrollIntent}
      onPointerMoveCapture={event => { if (event.buttons) scrollIntent(); }}
      onKeyDownCapture={scrollIntent}>
      {loading ? <div className="room__messages"><div className="msg-skeleton" aria-hidden>
        {Array.from({ length: 5 }, (_, i) => <div key={i} className={`msg-skeleton__row${i % 2 ? " msg-skeleton__row--mine" : ""}`}><i /><span /></div>)}
      </div></div> : messages.length === 0 ? <div className="room__messages"><div className="room__empty room__empty--thread">
        <p className="room__empty-brand">Майко</p><p className="room__empty-copy">Напишите первое сообщение</p>
        <TypingIndicator names={othersTyping} />
      </div></div> : <Virtuoso
        key={`${chatId}:${historyVersion}`}
        ref={virtuosoRef}
        className="room__messages room__messages--virtual"
        style={{ padding: 0, overflowAnchor: "none" }}
        data={items}
        firstItemIndex={firstItemIndex}
        context={{ names: othersTyping, hasMore, loadingOlder, preserveScroll: listWindow.prepending || listWindow.appendingHistory, anchorKey: `${firstItemIndex}:${items.length}`, scrollRevision: scrollRevisionRef, historyError, onLoadOlder: loadOlder }}
        components={listComponents}
        defaultItemHeight={76}
        alignToBottom
        atBottomThreshold={120}
        atBottomStateChange={onBottomChange}
        followOutput={false}
        totalListHeightChanged={scheduleInitialPosition}
        startReached={() => {
          const scroller = scrollerRef.current;
          if (hasMore && !historyError && initialScrollReadyRef.current && scroller && scroller.scrollTop < 600) void loadOlder();
        }}
        endReached={() => void loadNewer()}
        onScroll={() => {
          if (!hasNewer) return;
          const scroller = scrollerRef.current;
          if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 320) void loadNewer();
        }}
        overscan={listOverscan}
        increaseViewportBy={listViewport}
        skipAnimationFrameInResizeObserver
        computeItemKey={(_, item) => item.key}
        scrollerRef={bindScroller}
        itemContent={(_, item) => <div className="message-virtual-segment">{renderItem(item)}</div>}
      />}

      {(showJump || hasNewer) && !loading && (
        <button
          type="button"
          className={`room__jump ${pendingNew > 0 ? "has-new" : ""}`}
          onClick={jumpBottom}
          disabled={loadingOlder}
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
