"use client";

import {
  memo,
  useEffect,
  useRef,
  useState,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { motion } from "motion/react";
import type { ChatMessage, FileAttachment, PeopleUser } from "@/lib/types";
import { Avatar } from "@/components/chat/Avatar";
import {
  IconCheck,
  IconCheckDouble,
  IconDownload,
  IconFileKind,
  fileIconKind,
  IconPlay,
} from "@/lib/icons";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";
import {
  formatBytes,
  isAudioAttachment,
  isImageAttachment,
  isMediaAttachment,
  isVideoAttachment,
  isVoiceNote,
  audioDisplayName,
  bareMediaUrl,
  mediaSrc,
  signedMediaSrc,
  downloadHref,
  displayFileName,
  messageAttachments,
} from "@/lib/files";
import { audioTrackId, type AudioTrack } from "@/lib/audioPlayback";
import {
  highlightText,
  linkifyText,
} from "@/lib/text";
import { formatMessageTime } from "@/lib/dates";
import { VoiceBubble } from "@/components/chat/VoiceBubble";
import { VideoThumb } from "@/components/chat/VideoThumb";
import { MessageMenu } from "@/components/chat/MessageMenu";

type MessageBubbleProps = {
  message: ChatMessage;
  mine: boolean;
  peopleById?: Map<string, PeopleUser>;
  showMeta?: boolean;
  animate?: boolean;
  selfId?: string;
  searchQuery?: string;
  dimmed?: boolean;
  highlighted?: boolean;
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
  canDelete?: boolean;
  canEdit?: boolean;
  canForward?: boolean;
  peerReadAt?: number | null;
};

function truncate(value: string, max = 120) {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function resolveAuthor(
  message: ChatMessage,
  peopleById?: Map<string, PeopleUser>,
) {
  const byId =
    message.authorId && peopleById
      ? peopleById.get(message.authorId)
      : undefined;
  if (byId) {
    return {
      name: byId.displayName || byId.username,
      avatarUrl: byId.avatarUrl,
    };
  }

  return {
    name: message.author,
    avatarUrl: undefined as string | undefined,
  };
}

function FileBodyInner({
  message,
  mine,
  onOpenImage,
}: {
  message: ChatMessage;
  mine?: boolean;
  onOpenImage?: (src: string, name: string, kind?: "image" | "video") => void;
}) {
  const attachments = messageAttachments(message);
  if (!attachments.length) return null;

  const caption = (message.text || "").trim();
  const album = attachments.length > 1;

  if (album && attachments.every((file) => isMediaAttachment(file))) {
    const count = Math.min(attachments.length, 10);
    const visible = attachments.slice(0, count);
    const userCaption =
      caption &&
      caption !== "Фото" &&
      caption !== "Видео" &&
      !/^Альбом/i.test(caption);

    return (
      <div className={`bubble__album bubble__album--${Math.min(visible.length, 4)}`}>
        <div className="bubble__album-grid">
          {visible.map((file, index) => {
            const src = signedMediaSrc(file.url) || mediaSrc(file.url);
            const openSrc = signedMediaSrc(file.url) || bareMediaUrl(file.url);
            const video = isVideoAttachment(file);
            return (
              <button
                key={`${src}-${index}`}
                type="button"
                className="bubble__album-cell"
                onClick={() =>
                  onOpenImage?.(openSrc, file.name, video ? "video" : "image")
                }
                aria-label={video ? "Открыть видео" : "Открыть фото"}
              >
                {video ? (
                  <>
                    { }
                    <video
                      src={src}
                      muted
                      playsInline
                      preload="metadata"
                    />
                    <span className="bubble__video-play" aria-hidden>
                      <IconPlay size={18} />
                    </span>
                  </>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    fetchPriority="low"
                  />
                )}
              </button>
            );
          })}
        </div>
        {userCaption ? (
          <p className="bubble__text bubble__media-caption">{caption}</p>
        ) : null}
      </div>
    );
  }

  const file = attachments[0];
  const mime = file.mime || "";
  const isImage = isImageAttachment(file);
  const isAudio = isAudioAttachment(file);
  const isVideo = isVideoAttachment(file) || (mime.startsWith("video/") && !isAudio);
  const userCaption =
    caption &&
    caption !== file.name &&
    caption !== "Фото" &&
    caption !== "Видео" &&
    caption !== "Аудио" &&
    caption !== "Голосовое сообщение";

  if (isImage) {
    const src = signedMediaSrc(file.url) || mediaSrc(file.url);
    const openSrc = signedMediaSrc(file.url) || bareMediaUrl(file.url);
    return (
      <div className="bubble__media bubble__media--image">
        <button
          type="button"
          className="bubble__image-btn"
          onClick={() => onOpenImage?.(openSrc, file.name, "image")}
          aria-label="Открыть фото"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            className="bubble__image"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            referrerPolicy="no-referrer"
          />
        </button>
        {userCaption ? (
          <p className="bubble__text bubble__media-caption">{caption}</p>
        ) : null}
      </div>
    );
  }

  if (isVideo) {
    const openSrc = signedMediaSrc(file.url) || bareMediaUrl(file.url);
    return (
      <div className="bubble__media bubble__media--video">
        <VideoThumb
          url={file.url}
          onOpen={() => onOpenImage?.(openSrc, file.name, "video")}
        />
        {userCaption ? (
          <p className="bubble__text bubble__media-caption">{caption}</p>
        ) : null}
      </div>
    );
  }

  if (isAudio) {
    const audios = attachments.filter((item) => isAudioAttachment(item));
    const voiceOnly = audios.every((item) => isVoiceNote(item));
    const showUserCaption =
      !voiceOnly &&
      caption &&
      caption !== file.name &&
      caption !== audioDisplayName(file) &&
      caption !== "Аудио" &&
      caption !== "Голосовое сообщение";

    return (
      <div className={`bubble__audio ${voiceOnly ? "bubble__audio--voice" : ""}`}>
        {audios.map((item) => {
          const voice = isVoiceNote(item);
          const title = audioDisplayName(item);
          const src = signedMediaSrc(item.url) || mediaSrc(item.url);
          const track: AudioTrack = {
            id: audioTrackId(message.clientKey || message.id, item.url),
            messageId: message.id,
            roomId: message.room,
            src,
            kind: voice ? "voice" : "audio",
            title,
            author: message.author,
            createdAt: message.createdAt,
          };
          return (
            <div key={track.id} className="bubble__audio-item">
              {!voice && (
                <div className="bubble__audio-meta">
                  <strong className="bubble__audio-name" title={title}>
                    {title}
                  </strong>
                  <span className="bubble__audio-size">{formatBytes(item.size)}</span>
                </div>
              )}
              <VoiceBubble src={src} mine={mine} track={track} />
            </div>
          );
        })}
        {showUserCaption ? (
          <p className="bubble__text bubble__audio-caption">{caption}</p>
        ) : null}
      </div>
    );
  }

  const others = attachments.filter((item) => !isMediaAttachment(item) && !isAudioAttachment(item));
  const list = others.length ? others : [file];

  return (
    <div className="bubble__files">
      {list.map((item) => {
        const title = displayFileName(item.name);
        const href = downloadHref(item.url);
        const kind = fileIconKind(item.name, item.mime);
        const ext = title.includes(".")
          ? title.split(".").pop()!.slice(0, 4).toUpperCase()
          : "";
        return (
          <a
            key={item.url || item.name}
            className={`bubble__file-link bubble__file-link--${kind}`}
            href={href}
            download={title}
            title={title}
          >
            <span className={`bubble__file-icon bubble__file-icon--${kind}`} aria-hidden>
              <IconFileKind kind={kind} size={20} />
            </span>
            <span className="bubble__file-meta">
              <strong className="bubble__file-name">{title}</strong>
              <span className="bubble__file-size">
                {ext ? `${ext} · ` : ""}
                {formatBytes(item.size)}
              </span>
            </span>
            <span className="bubble__download" aria-hidden>
              <IconDownload size={16} />
            </span>
          </a>
        );
      })}
      {userCaption ? (
        <p className="bubble__text bubble__media-caption">{caption}</p>
      ) : null}
    </div>
  );
}

/** Skip remount when only reactions / status change. */
const FileBody = memo(FileBodyInner, (prev, next) => {
  if (
    prev.mine !== next.mine ||
    prev.onOpenImage !== next.onOpenImage ||
    prev.message.text !== next.message.text ||
    prev.message.id !== next.message.id ||
    prev.message.clientKey !== next.message.clientKey ||
    prev.message.room !== next.message.room ||
    prev.message.author !== next.message.author
  ) {
    return false;
  }
  const a = messageAttachments(prev.message);
  const b = messageAttachments(next.message);
  if (a.length !== b.length) return false;
  return a.every(
    (file, index) =>
      file.url === b[index]?.url &&
      file.mime === b[index]?.mime &&
      file.name === b[index]?.name &&
      file.size === b[index]?.size,
  );
});

function MessageBubbleInner({
  message,
  mine,
  peopleById,
  showMeta = true,
  animate = true,
  selfId,
  searchQuery = "",
  dimmed = false,
  highlighted = false,
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
  canDelete = false,
  canEdit = false,
  canForward = false,
  peerReadAt = null,
}: MessageBubbleProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  if (message.kind === "invite" && message.invite) {
    const invite = message.invite;
    const canRespond =
      invite.status === "pending" &&
      Boolean(selfId) &&
      message.authorId !== selfId;
    const statusLabel =
      invite.status === "accepted"
        ? "Принято"
        : invite.status === "declined"
          ? "Отклонено"
          : invite.status === "expired"
            ? "Группа удалена"
            : canRespond
              ? "Вас пригласили"
              : "Ожидает ответа";
    const inviteText =
      invite.status === "expired"
        ? `Группа «${invite.groupTitle}» удалена`
        : mine
          ? "Приглашение отправлено в личные"
          : `${message.author} приглашает в группу`;

    return (
      <div
        className={`invite-card ${mine ? "invite-card--mine" : ""} ${
          invite.status === "expired" ? "invite-card--expired" : ""
        }`}
      >
        <p className="invite-card__eyebrow">{statusLabel}</p>
        <strong className="invite-card__title">{invite.groupTitle}</strong>
        <p className="invite-card__text">{inviteText}</p>
        {canRespond && onInviteRespond ? (
          <div className="invite-card__actions">
            <button
              type="button"
              className="invite-card__accept"
              onClick={() => onInviteRespond(message.id, true)}
            >
              Принять
            </button>
            <button
              type="button"
              className="invite-card__decline"
              onClick={() => onInviteRespond(message.id, false)}
            >
              Отклонить
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (message.kind === "system" || message.kind === "call") {
    const isTombstone =
      message.kind === "system" &&
      (message.text === "Сообщение удалено" ||
        message.text === "Файл удалён из сообщения");
    return (
      <p
        className={`system-msg ${
          message.kind === "call" ? "system-msg--call" : ""
        } ${isTombstone ? "system-msg--tombstone" : ""}`}
      >
        {message.kind === "call" ? (
          <span className="system-msg__call-dot" aria-hidden />
        ) : null}
        {message.text}
      </p>
    );
  }

  const author = resolveAuthor(message, peopleById);
  const attachments = messageAttachments(message);
  const audioMsg = attachments.some((file) => isAudioAttachment(file));
  const mediaMsg = attachments.some((file) => isMediaAttachment(file));
  const canCopy = !audioMsg && !mediaMsg;
  const copyText =
    message.kind === "file"
      ? message.file?.url || message.text
      : message.text;
  const canDownload = attachments.length > 0;

  function handleDownload() {
    const file = attachments[0];
    if (!file?.url) return;
    const downloadUrl = `${file.url}${file.url.includes("?") ? "&" : "?"}download=1`;
    window.open(downloadUrl, "_blank");
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(copyText);
      onCopied?.();
    } catch {
      /* ignore */
    }
  }

  function clearLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStart.current = null;
  }

  function openMenu() {
    setMenuOpen(true);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(12);
      } catch {
        /* ignore */
      }
    }
  }

  function onTouchStart(event: ReactTouchEvent) {
    const touch = event.touches[0];
    if (!touch) return;
    touchStart.current = { x: touch.clientX, y: touch.clientY };
    longPressTimer.current = setTimeout(() => {
      openMenu();
    }, 420);
  }

  function onTouchMove(event: ReactTouchEvent) {
    const start = touchStart.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    if (
      Math.abs(touch.clientX - start.x) > 12 ||
      Math.abs(touch.clientY - start.y) > 12
    ) {
      clearLongPress();
    }
  }

  const textNode = searchQuery.trim()
    ? highlightText(message.text, searchQuery)
    : linkifyText(message.text);

  const timeLabel = formatMessageTime(message.createdAt);
  const displayName = mine ? "Вы" : author.name;

  const body = (
    <>
      {showMeta ? (
        <Avatar name={author.name} src={author.avatarUrl} size="md" />
      ) : (
        <span className="bubble-row__spacer" aria-hidden>
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {timeLabel}
          </time>
        </span>
      )}
      <div
        ref={bubbleRef}
        className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"} ${
          showMeta ? "" : "bubble--compact"
        } ${mediaMsg ? "bubble--media" : ""} ${
          audioMsg ? "bubble--audio" : ""
        } ${menuOpen ? "is-actions-open" : ""} ${message.status === "pending" ? "bubble--pending" : ""} ${
          message.status === "failed" ? "bubble--failed" : ""
        }`}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu();
        }}
      >
        {showMeta && (
          <div className="bubble__meta-line">
            <span className="bubble__author">{displayName}</span>
            <time
              className="bubble__time"
              dateTime={new Date(message.createdAt).toISOString()}
            >
              {timeLabel}
            </time>
            {mine && message.status === "pending" && (
              <span className="bubble__status" aria-label="отправка">
                <i className="bubble__spinner" aria-hidden />
              </span>
            )}
          </div>
        )}

        {message.forwardedFrom && (
          <p className="bubble__forward">
            Переслано от {message.forwardedFrom.author}
          </p>
        )}

        {message.replyTo && (
          <button
            type="button"
            className={`bubble__reply ${
              message.replyTo.text === "Сообщение удалено" ||
              message.replyTo.text === "Файл удалён из сообщения"
                ? "bubble__reply--deleted"
                : ""
            }`}
            onClick={() => onJumpTo?.(message.replyTo!.id)}
          >
            <strong>{message.replyTo.author}</strong>
            <span>{truncate(message.replyTo.text)}</span>
          </button>
        )}

        {message.kind === "file" ? (
          <FileBody message={message} mine={mine} onOpenImage={onOpenImage} />
        ) : (
          <p className="bubble__text">
            {textNode}
            {message.editedAt ? (
              <em className="bubble__edited"> изменено</em>
            ) : null}
          </p>
        )}



        {mine &&
          !message.status &&
          !mediaMsg &&
          message.kind !== "file" && (
          <span
            className={`bubble__receipt ${
              peerReadAt && peerReadAt >= message.createdAt ? "is-read" : ""
            }`}
            aria-label={
              peerReadAt && peerReadAt >= message.createdAt
                ? "Прочитано"
                : "Отправлено"
            }
          >
            {peerReadAt && peerReadAt >= message.createdAt ? (
              <IconCheckDouble size={14} />
            ) : (
              <IconCheck size={14} />
            )}
          </span>
        )}

        {!!message.reactions?.length && (
          <div className="bubble__reactions">
            {message.reactions.map((reaction) => {
              const active = selfId
                ? reaction.userIds.includes(selfId)
                : false;
              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={`bubble__reaction ${active ? "is-active" : ""}`}
                  onClick={() => onReact?.(message.id, reaction.emoji)}
                >
                  <span>{reaction.emoji}</span>
                  <em>{reaction.userIds.length}</em>
                </button>
              );
            })}
          </div>
        )}

        {mine && message.status === "failed" && (
          <div className="bubble__fail">
            <button
              type="button"
              className="bubble__chip bubble__chip--retry"
              onClick={() => onRetry?.(message.id)}
            >
              Повторить
            </button>
            {onDiscard && (
              <button
                type="button"
                className="bubble__chip bubble__chip--discard"
                onClick={() => onDiscard(message.id)}
              >
                Удалить
              </button>
            )}
          </div>
        )}
      </div>

      <MessageMenu
        open={menuOpen}
        anchorRef={bubbleRef}
        mine={mine}
        canCopy={canCopy}
        canDelete={Boolean(canDelete && onDelete && !message.status)}
        canEdit={Boolean(canEdit && onEdit && mine && !message.status && message.kind !== "file")}
        canForward={Boolean(canForward && onForward && !message.status)}
        canRetry={Boolean(mine && message.status === "failed")}
        canDiscard={Boolean(mine && message.status === "failed" && onDiscard)}
        canDownload={canDownload}
        onDownload={() => {
          handleDownload();
          setMenuOpen(false);
        }}
        onClose={() => setMenuOpen(false)}
        onReply={() => {
          onReply?.(message);
          setMenuOpen(false);
        }}
        onCopy={() => {
          void handleCopy();
          setMenuOpen(false);
        }}
        onReact={(emoji) => onReact?.(message.id, emoji)}
        onEdit={() => {
          onEdit?.(message);
          setMenuOpen(false);
        }}
        onForward={() => {
          onForward?.(message);
          setMenuOpen(false);
        }}
        onRetry={() => {
          onRetry?.(message.id);
          setMenuOpen(false);
        }}
        onDiscard={() => {
          onDiscard?.(message.id);
          setMenuOpen(false);
        }}
        onDelete={() => {
          setMenuOpen(false);
          setConfirmDelete(true);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Удалить сообщение?"
        body="Сообщение будет удалено для всех в этом чате."
        confirmLabel="Удалить"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          onDelete?.(message.id);
          setConfirmDelete(false);
        }}
      />
    </>
  );

  /* Discord-style full-width row: avatar | name+time | body (not TG bubbles) */
  const className = `bubble-row bubble-row--plaque ${mine ? "bubble-row--mine" : ""} ${
    showMeta ? "" : "bubble-row--compact"
  } ${dimmed ? "is-dimmed" : ""} ${highlighted ? "is-flash" : ""}`;

  const touchProps = {
    title: "Удержите для действий",
    onDoubleClick: (event: { target: EventTarget }) => {
      const node = event.target instanceof Element ? event.target : null;
      if (node?.closest(".voice-bubble, .bubble__audio, button, [role='slider']")) {
        return;
      }
      onReply?.(message);
    },
    onTouchStart,
    onTouchMove,
    onTouchEnd: clearLongPress,
    onTouchCancel: clearLongPress,
  };

  if (!animate) {
    return (
      <article id={`msg-${message.id}`} className={className} {...touchProps}>
        {body}
      </article>
    );
  }

  return (
    <motion.article
      id={`msg-${message.id}`}
      className={className}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      {...touchProps}
    >
      {body}
    </motion.article>
  );
}

export const MessageBubble = memo(MessageBubbleInner);
