"use client";

import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { motion } from "motion/react";
import type {
  ChatMessage,
  FileAttachment,
  MessageStatus,
  PeopleUser,
} from "@/lib/types";
import { Avatar } from "@/components/chat/Avatar";
import {
  IconTgRead,
  IconTgSent,
  IconDownload,
  IconFileKind,
  fileIconKind,
  IconPlay,
  IconImage,
  IconClose,
} from "@/lib/icons";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";
import {
  formatBytes,
  fitGifDisplaySize,
  isAudioAttachment,
  isGifAttachment,
  isImageAttachment,
  isMediaAttachment,
  isVideoAttachment,
  isVoiceNote,
  audioDisplayName,
  bareMediaUrl,
  mediaSrc,
  signedMediaSrc,
  thumbSrc,
  withoutThumbParam,
  downloadHref,
  displayFileName,
  messageAttachments,
  parseMediaSize,
} from "@/lib/files";
import { albumBounds, layoutMediaGroup } from "@/lib/albumLayout";
import { audioTrackId, type AudioTrack } from "@/lib/audioPlayback";
import { renderMessageText } from "@/lib/text";
import { soloEmojiSizePx, splitTextAndEmoji } from "@/lib/emojiText";
import { formatMessageTime } from "@/lib/dates";
import { VoiceBubble } from "@/components/chat/VoiceBubble";
import { VoiceTranscript } from "@/components/chat/VoiceTranscript";
import { VideoThumb } from "@/components/chat/VideoThumb";
import { MessageMenu } from "@/components/chat/MessageMenu";

type MessageBubbleProps = {
  message: ChatMessage;
  mine: boolean;
  peopleById?: Map<string, PeopleUser>;
  showMeta?: boolean;
  showAvatar?: boolean;
  /** Avatar lives in the sticky group rail — no row spacer. */
  hideAvatarColumn?: boolean;
  /** tdesktop isBubbleAttachedToPrevious / isBubbleAttachedToNext */
  attachPrev?: boolean;
  attachNext?: boolean;
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
  onCancelUpload?: (messageId: string) => void;
  onDiscard?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (message: ChatMessage) => void;
  onForward?: (message: ChatMessage) => void;
  onInviteRespond?: (messageId: string, accept: boolean) => void;
  onTranscribe?: (messageId: string) => void;
  /** Клик по стикеру — открыть пак, из которого он отправлен. */
  onOpenStickerPack?: (packId: string, stickerId: string) => void;
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

/** Colored caption plaque — tdesktop Photo/Gif skipBubbleTail when media fills the bubble. */
function hasVisibleMediaCaption(message: ChatMessage) {
  const caption = (message.text || "").trim();
  if (!caption) return false;
  const attachments = messageAttachments(message);
  if (!attachments.some((file) => isMediaAttachment(file))) return false;
  if (attachments.length > 1) {
    return (
      caption !== "Фото" &&
      caption !== "GIF" &&
      caption !== "Видео" &&
      !/^Альбом/i.test(caption)
    );
  }
  const file = attachments[0];
  return (
    caption !== file.name &&
    caption !== "Фото" &&
    caption !== "GIF" &&
    caption !== "Видео" &&
    caption !== "Аудио" &&
    caption !== "Голосовое сообщение"
  );
}

function plaqueShapeClass(
  attachPrev: boolean,
  attachNext: boolean,
  skipTail: boolean,
) {
  return [
    attachPrev ? "bubble--attach-prev" : "",
    attachNext ? "bubble--attach-next" : "",
    skipTail ? "bubble--skip-tail" : "bubble--tail",
  ]
    .filter(Boolean)
    .join(" ");
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

function SendMeta({
  createdAt,
  mine = false,
  status,
  peerReadAt,
  className,
  inline = false,
}: {
  createdAt: number;
  mine?: boolean;
  status?: MessageStatus;
  peerReadAt?: number | null;
  className?: string;
  inline?: boolean;
}) {
  const read = Boolean(mine && peerReadAt && peerReadAt >= createdAt);
  const sending = mine && status === "pending";
  const failed = mine && status === "failed";
  const clock = (
    <time
      className={`bubble__time${className ? ` ${className}` : ""}`}
      dateTime={new Date(createdAt).toISOString()}
    >
      {formatMessageTime(createdAt)}
      {mine && !failed && (
        <span
          className={`bubble__receipt${read ? " is-read" : ""}${sending ? " is-sending" : ""}`}
          aria-label={
            sending ? "отправка" : read ? "Прочитано" : "Отправлено"
          }
        >
          {sending ? (
            <svg className="bubble__clock" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <line className="bubble__clock-hour" x1="6" y1="6" x2="6" y2="3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <line className="bubble__clock-minute" x1="6" y1="6" x2="6" y2="2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          ) : read ? (
            <IconTgRead size={16} />
          ) : (
            <IconTgSent size={12} />
          )}
        </span>
      )}
    </time>
  );
  return inline ? (
    <>
      <span className="bubble__time-space" aria-hidden="true">{clock}</span>
      <span className="bubble__time-corner">{clock}</span>
    </>
  ) : clock;
}

function MediaCaption({
  caption,
  createdAt,
  mine,
  status,
  peerReadAt,
}: {
  caption?: string;
  createdAt: number;
  mine?: boolean;
  status?: MessageStatus;
  peerReadAt?: number | null;
}) {
  const clock = (
    <SendMeta
      createdAt={createdAt}
      mine={mine}
      status={status}
      peerReadAt={peerReadAt}
      className={caption ? undefined : "bubble__media-time"}
      inline={Boolean(caption)}
    />
  );
  if (caption) {
    return (
      <p className="bubble__text bubble__media-caption">
        <span className="bubble__media-caption-text">
          {renderMessageText(caption)}
          {clock}
        </span>
      </p>
    );
  }
  return clock;
}

function AlbumMosaic({
  files,
  onOpenImage,
  overlay,
  uploads,
  onCancelUpload,
}: {
  files: FileAttachment[];
  onOpenImage?: (src: string, name: string, kind?: "image" | "video") => void;
  overlay?: ReactNode;
  /** Per-cell upload progress; cells at 1 are finished and show no ring. */
  uploads?: number[];
  onCancelUpload?: () => void;
}) {
  const [probed, setProbed] = useState<Record<string, { width: number; height: number }>>(
    {},
  );
  const gridRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = gridRef.current;
    if (!node || near) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  const sizes = files.map((file, index) => {
    const stored = parseMediaSize(file);
    if (stored) return stored;
    return probed[`${file.url}:${index}`] || { width: 1280, height: 960 };
  });
  const cells = layoutMediaGroup(sizes);
  const box = albumBounds(cells);

  function rememberSize(key: string, width: number, height: number) {
    const next = parseMediaSize({ width, height });
    if (!next) return;
    setProbed((prev) => {
      const cur = prev[key];
      if (cur && cur.width === next.width && cur.height === next.height) {
        return prev;
      }
      return { ...prev, [key]: next };
    });
  }

  return (
    <div
      ref={gridRef}
      className="bubble__album-grid"
      style={{
        width: "100%",
        maxWidth: box.width,
        aspectRatio: `${box.width} / ${box.height}`,
      }}
    >
      {files.map((file, index) => {
        const cell = cells[index];
        if (!cell) return null;
        const src = signedMediaSrc(file.url) || mediaSrc(file.url);
        const openSrc = signedMediaSrc(file.url) || bareMediaUrl(file.url);
        const video = isVideoAttachment(file);
        const key = `${file.url}:${index}`;
        const known = Boolean(parseMediaSize(file));
        return (
          <button
            key={key}
            type="button"
            className="bubble__album-cell"
            style={{
              left: `${(cell.x / box.width) * 100}%`,
              top: `${(cell.y / box.height) * 100}%`,
              width: `${(cell.width / box.width) * 100}%`,
              height: `${(cell.height / box.height) * 100}%`,
            }}
            onClick={() =>
              onOpenImage?.(openSrc, file.name, video ? "video" : "image")
            }
            aria-label={video ? "Открыть видео" : "Открыть фото"}
          >
            {video ? (
              <>
                <video
                  src={near ? src : undefined}
                  muted
                  playsInline
                  preload={near ? "metadata" : "none"}
                  controls={false}
                  onLoadedMetadata={(event) => {
                    if (known) return;
                    rememberSize(
                      key,
                      event.currentTarget.videoWidth,
                      event.currentTarget.videoHeight,
                    );
                  }}
                  onPlay={(event) => {
                    event.currentTarget.pause();
                  }}
                />
                <span className="bubble__video-play" aria-hidden>
                  <IconPlay size={18} />
                </span>
              </>
            ) : (
              <PhotoImage
                src={thumbSrc(file.url, 430)}
                onLoad={(event) => {
                  if (known) return;
                  rememberSize(
                    key,
                    event.currentTarget.naturalWidth,
                    event.currentTarget.naturalHeight,
                  );
                }}
              />
            )}
          </button>
        );
      })}
      {uploads
        ? files.map((file, index) => {
            const cell = cells[index];
            const progress = uploads[index];
            if (!cell || progress === undefined || progress >= 1) return null;
            return (
              // Sibling of the cell button — a ring button can't nest inside it.
              <div
                key={`upload-${file.url}:${index}`}
                className="bubble__upload-overlay bubble__upload-overlay--cell"
                style={{
                  left: `${(cell.x / box.width) * 100}%`,
                  top: `${(cell.y / box.height) * 100}%`,
                  width: `${(cell.width / box.width) * 100}%`,
                  height: `${(cell.height / box.height) * 100}%`,
                }}
              >
                <UploadRing progress={progress} onCancel={onCancelUpload} variant="media" />
              </div>
            );
          })
        : null}
      {overlay}
    </div>
  );
}

/** Telegram Gif: fit inside `st::maxGifSize` (320), never stretch to photo width. */
function GifMedia({
  file,
  src,
  openSrc,
  onOpenImage,
}: {
  file: FileAttachment;
  src: string;
  openSrc: string;
  onOpenImage?: (src: string, name: string, kind?: "image" | "video") => void;
}) {
  const stored = parseMediaSize(file);
  const [probed, setProbed] = useState<{ width: number; height: number } | null>(
    stored || null,
  );
  const box = probed
    ? fitGifDisplaySize(probed.width, probed.height)
    : undefined;

  return (
    <button
      type="button"
      className="bubble__image-btn bubble__image-btn--gif"
      style={
        box
          ? {
              width: box.width,
              maxWidth: "100%",
              height: "auto",
              aspectRatio: `${box.width} / ${box.height}`,
            }
          : undefined
      }
      onClick={() => onOpenImage?.(openSrc, file.name, "image")}
      aria-label="Открыть GIF"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <PhotoImage
        src={src}
        className="bubble__image bubble__image--gif"
        onLoad={(event) => {
          const next = parseMediaSize({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          });
          if (!next) return;
          setProbed((prev) => {
            if (!prev) return next;
            if (next.width * next.height <= prev.width * prev.height) {
              return prev;
            }
            return next;
          });
        }}
      />
    </button>
  );
}

const RING_RADIUS = 20;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Telegram-style upload ring: spinning arc that fills with progress; tap cancels. */
function UploadRing({
  progress,
  onCancel,
  variant,
}: {
  progress: number;
  onCancel?: () => void;
  variant: "media" | "file" | "voice";
}) {
  const ratio = Math.min(1, Math.max(0.04, progress));
  return (
    <button
      type="button"
      className={`upload-ring upload-ring--${variant}`}
      aria-label={`Отменить загрузку (${Math.round(progress * 100)}%)`}
      title="Отменить загрузку"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onCancel?.();
      }}
    >
      <svg className="upload-ring__svg" viewBox="0 0 48 48" aria-hidden>
        <circle
          className="upload-ring__bar"
          cx="24"
          cy="24"
          r={RING_RADIUS}
          strokeDasharray={RING_LENGTH}
          strokeDashoffset={RING_LENGTH * (1 - ratio)}
        />
      </svg>
      <IconClose size={variant === "media" ? 18 : 14} />
    </button>
  );
}

function MediaUploadOverlay({
  progress,
  onCancel,
}: {
  progress: number;
  onCancel?: () => void;
}) {
  return (
    <div className="bubble__upload-overlay">
      <UploadRing progress={progress} onCancel={onCancel} variant="media" />
    </div>
  );
}

/** Image with one cache-busted retry and a clickable broken placeholder. */
function PhotoImage({
  src,
  alt = "",
  className,
  loading = "lazy",
  onLoad,
}: {
  src: string;
  alt?: string;
  className?: string;
  loading?: "lazy" | "eager";
  onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);
  const [source, setSource] = useState(src);

  useEffect(() => {
    setSource(src);
    setAttempt(0);
    setBroken(false);
  }, [src]);

  if (broken) {
    return (
      <button
        type="button"
        className="bubble__media-retry"
        aria-label="Повторить загрузку"
        onClick={(event) => {
          // Don't let the outer bubble button open the lightbox.
          event.stopPropagation();
          setBroken(false);
          setAttempt((value) => value + 1);
        }}
      >
        <IconImage size={22} />
        <span>Не удалось загрузить</span>
      </button>
    );
  }

  const url =
    attempt > 0
      ? `${source}${source.includes("?") ? "&" : "?"}r=${attempt}`
      : source;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className={className}
      loading={loading}
      decoding="async"
      fetchPriority="auto"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      onError={() => {
        const original = withoutThumbParam(source);
        if (original !== source) {
          setSource(original);
          setAttempt(0);
          return;
        }
        if (attempt < 1) setAttempt((value) => value + 1);
        else setBroken(true);
      }}
    />
  );
}

function FileBodyInner({
  message,
  mine,
  peerReadAt,
  onOpenImage,
  onTranscribe,
  onCancelUpload,
}: {
  message: ChatMessage;
  mine?: boolean;
  peerReadAt?: number | null;
  onOpenImage?: (src: string, name: string, kind?: "image" | "video") => void;
  onTranscribe?: (messageId: string) => void;
  onCancelUpload?: (messageId: string) => void;
}) {
  const attachments = messageAttachments(message);
  if (!attachments.length) return null;

  const caption = (message.text || "").trim();
  const album = attachments.length > 1;
  const uploadProgress = message.uploadProgress;
  const uploading = uploadProgress !== undefined;
  const cancelUpload = () => onCancelUpload?.(message.id);
  const mediaUpload = uploading ? (
    <MediaUploadOverlay progress={uploadProgress} onCancel={cancelUpload} />
  ) : null;

  if (album && attachments.every((file) => isMediaAttachment(file))) {
    const count = Math.min(attachments.length, 10);
    const visible = attachments.slice(0, count);
    const userCaption =
      caption &&
      caption !== "Фото" &&
      caption !== "GIF" &&
      caption !== "Видео" &&
      !/^Альбом/i.test(caption);

    return (
      <div className="bubble__album">
        <AlbumMosaic
          files={visible}
          onOpenImage={onOpenImage}
          uploads={uploading ? message.uploadFileProgress?.slice(0, count) : undefined}
          onCancelUpload={cancelUpload}
          overlay={
            <>
              {uploading && !message.uploadFileProgress ? mediaUpload : null}
              {userCaption ? null : (
                <MediaCaption
                  createdAt={message.createdAt}
                  mine={mine}
                  status={message.status}
                  peerReadAt={peerReadAt}
                />
              )}
            </>
          }
        />
        {userCaption ? (
          <MediaCaption
            caption={caption}
            createdAt={message.createdAt}
            mine={mine}
            status={message.status}
            peerReadAt={peerReadAt}
          />
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
    caption !== "GIF" &&
    caption !== "Видео" &&
    caption !== "Аудио" &&
    caption !== "Голосовое сообщение";

  if (isImage) {
    const src = signedMediaSrc(file.url) || mediaSrc(file.url);
    const openSrc = signedMediaSrc(file.url) || bareMediaUrl(file.url);
    const gif = isGifAttachment(file);
    return (
      <div
        className={`bubble__media bubble__media--image${gif ? " bubble__media--gif" : ""}`}
      >
        {gif ? (
          <GifMedia
            file={file}
            src={src}
            openSrc={openSrc}
            onOpenImage={onOpenImage}
          />
        ) : (
          <button
            type="button"
            className="bubble__image-btn"
            onClick={() => onOpenImage?.(openSrc, file.name, "image")}
            aria-label="Открыть фото"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <PhotoImage src={thumbSrc(file.url, 430)} className="bubble__image" />
          </button>
        )}
        {mediaUpload}
        <MediaCaption
          caption={userCaption ? caption : undefined}
          createdAt={message.createdAt}
          mine={mine}
          status={message.status}
          peerReadAt={peerReadAt}
        />
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
        {mediaUpload}
        <MediaCaption
          caption={userCaption ? caption : undefined}
          createdAt={message.createdAt}
          mine={mine}
          status={message.status}
          peerReadAt={peerReadAt}
        />
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
              {uploading ? (
                <div className="bubble__upload-slot">
                  <VoiceBubble
                    src={src}
                    mine={mine}
                    track={track}
                  />
                  <UploadRing
                    progress={uploadProgress}
                    onCancel={cancelUpload}
                    variant="voice"
                  />
                </div>
              ) : (
                <VoiceBubble
                  src={src}
                  mine={mine}
                  track={track}
                />
              )}
              {voice ? (
                <VoiceTranscript
                  message={message}
                  mine={mine}
                  clock={
                    <SendMeta
                      createdAt={message.createdAt}
                      mine={mine}
                      status={message.status}
                      peerReadAt={peerReadAt}
                      className="voice-transcript__time"
                    />
                  }
                  onTranscribe={onTranscribe}
                />
              ) : null}
            </div>
          );
        })}
        {showUserCaption ? (
          <p className="bubble__text bubble__audio-caption">
            {renderMessageText(caption)}
            <SendMeta
              createdAt={message.createdAt}
              mine={mine}
              status={message.status}
              peerReadAt={peerReadAt}
            />
          </p>
        ) : voiceOnly ? null : (
          <SendMeta
            createdAt={message.createdAt}
            mine={mine}
            status={message.status}
            peerReadAt={peerReadAt}
            className="bubble__audio-clock"
          />
        )}
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
            {uploading ? (
              <UploadRing
                progress={uploadProgress}
                onCancel={cancelUpload}
                variant="file"
              />
            ) : (
              <span className={`bubble__file-icon bubble__file-icon--${kind}`} aria-hidden>
                <IconFileKind kind={kind} size={20} />
              </span>
            )}
            <span className="bubble__file-meta">
              <strong className="bubble__file-name">{title}</strong>
              <span className="bubble__file-size">
                {uploading
                  ? `${formatBytes(Math.round(item.size * uploadProgress))} / ${formatBytes(item.size)}`
                  : `${ext ? `${ext} · ` : ""}${formatBytes(item.size)}`}
              </span>
            </span>
            {uploading ? null : (
              <span className="bubble__download" aria-hidden>
                <IconDownload size={16} />
              </span>
            )}
          </a>
        );
      })}
      {userCaption ? (
        <p className="bubble__text bubble__media-caption">
          <span className="bubble__media-caption-text">
            {renderMessageText(caption)}
            <SendMeta
              createdAt={message.createdAt}
              mine={mine}
              status={message.status}
              peerReadAt={peerReadAt}
            />
          </span>
        </p>
      ) : (
        <SendMeta
          createdAt={message.createdAt}
          mine={mine}
          status={message.status}
          peerReadAt={peerReadAt}
        />
      )}
    </div>
  );
}

/** Skip remount when only reactions / status change. */
const FileBody = memo(FileBodyInner, (prev, next) => {
  if (
    prev.mine !== next.mine ||
    prev.peerReadAt !== next.peerReadAt ||
    prev.message.status !== next.message.status ||
    prev.message.uploadProgress !== next.message.uploadProgress ||
    prev.message.uploadFileProgress !== next.message.uploadFileProgress ||
    prev.message.createdAt !== next.message.createdAt ||
    prev.onOpenImage !== next.onOpenImage ||
    prev.onTranscribe !== next.onTranscribe ||
    prev.onCancelUpload !== next.onCancelUpload ||
    prev.message.text !== next.message.text ||
    prev.message.transcription !== next.message.transcription ||
    prev.message.transcriptionStatus !== next.message.transcriptionStatus ||
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
      file.size === b[index]?.size &&
      file.width === b[index]?.width &&
      file.height === b[index]?.height,
  );
});

function MessageBubbleInner({
  message,
  mine,
  peopleById,
  showMeta = true,
  showAvatar = true,
  hideAvatarColumn = false,
  attachPrev = false,
  attachNext = false,
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
  onCancelUpload,
  onDiscard,
  onDelete,
  onEdit,
  onForward,
  onInviteRespond,
  onTranscribe,
  onOpenStickerPack,
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
  const selectedReactions = (message.reactions ?? [])
    .filter((reaction) => selfId && reaction.userIds.includes(selfId))
    .map((reaction) => reaction.emoji);
  const reactionClock = message.kind === "text" && soloEmojiSizePx(message.text) === 0;
  const reactions = message.reactions?.length ? (
    <div className="bubble__reactions" role="group" aria-label="Реакции на сообщение">
      {message.reactions.filter((reaction) => reaction.userIds.length > 0).map((reaction) => {
        const active = selectedReactions.includes(reaction.emoji);
        const users = reaction.userIds.map((id) => peopleById?.get(id));
        const showAvatars = users.every(Boolean);
        return (
          <button
            key={reaction.emoji}
            type="button"
            className={`bubble__reaction${active ? " is-active" : ""}`}
            aria-pressed={active}
            aria-label={`${reaction.emoji}: ${reaction.userIds.length}. ${active ? "Убрать" : "Поставить"} реакцию`}
            title={users.map((user, index) => user?.displayName || (reaction.userIds[index] === selfId ? "Вы" : "Участник")).join(", ")}
            disabled={!onReact || Boolean(message.status)}
            onClick={() => onReact?.(message.id, reaction.emoji)}
          >
            <span className="bubble__reaction-emoji" aria-hidden="true">{reaction.emoji}</span>
            {showAvatars && (
              <span className="bubble__reaction-avatars" aria-hidden="true">
                {users.slice(0, 3).map((user) => (
                  <Avatar key={user!.id} name={user!.displayName || user!.username} src={user!.avatarUrl} size="sm" className="bubble__reaction-avatar" />
                ))}
              </span>
            )}
            {(!showAvatars || users.length > 3) && <em aria-hidden="true">{reaction.userIds.length}</em>}
          </button>
        );
      })}
      {reactionClock && <SendMeta createdAt={message.createdAt} mine={mine} status={message.status} peerReadAt={peerReadAt} />}
    </div>
  ) : null;

  // ─── Стикер ──────────────────────────────────────────────────────────
  if (message.kind === "sticker" && message.sticker) {
    const sticker = message.sticker;
    const stickerClassName = `bubble-row bubble-row--plaque bubble-row--sticker ${
      mine ? "bubble-row--mine" : ""
    } ${showMeta ? "" : "bubble-row--compact"} ${
      attachPrev ? "bubble-row--attach-prev" : ""
    } ${attachNext ? "bubble-row--attach-next" : ""}`;
    const stickerInner = (
      <>
        {hideAvatarColumn ? null : showAvatar ? (
          <Avatar name={author.name} src={author.avatarUrl} size="md" />
        ) : (
          <span className="bubble-row__spacer" aria-hidden />
        )}
        <div
          ref={bubbleRef}
          className="sticker-bubble-wrap"
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu();
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={clearLongPress}
          onTouchCancel={clearLongPress}
        >
        <button
          type="button"
          className="sticker-bubble"
          onClick={(event) => {
            event.stopPropagation();
            onOpenStickerPack?.(sticker.packId, sticker.stickerId);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onReply?.(message);
          }}
          title="Нажмите, чтобы открыть пак"
          aria-label="Открыть пак стикеров"
        >
          {sticker.animated ? (
            <video
              src={sticker.url}
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                objectPosition: "center",
                display: "block",
                pointerEvents: "none",
              }}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={sticker.url}
              alt="Стикер"
              draggable={false}
              loading="lazy"
              decoding="async"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                objectPosition: "center",
                display: "block",
                pointerEvents: "none",
              }}
            />
          )}
        </button>
        <SendMeta
          createdAt={message.createdAt}
          mine={mine}
          status={message.status}
          peerReadAt={peerReadAt}
          className="bubble__sticker-time"
        />
        {reactions}
        </div>
        <MessageMenu
          open={menuOpen}
          anchorRef={bubbleRef}
          mine={mine}
          selectedReactions={selectedReactions}
          canCopy={false}
          canDelete={false}
          canEdit={false}
          canForward={Boolean(onForward)}
          canRetry={false}
          canDiscard={false}
          canDownload={false}
          onClose={() => setMenuOpen(false)}
          onReply={() => {
            onReply?.(message);
            setMenuOpen(false);
          }}
          onCopy={() => setMenuOpen(false)}
          onReact={(emoji) => onReact?.(message.id, emoji)}
          onForward={() => {
            onForward?.(message);
            setMenuOpen(false);
          }}
        />
      </>
    );

    if (!animate) {
      return (
        <article id={`msg-${message.id}`} className={stickerClassName}>
          {stickerInner}
        </article>
      );
    }

    return (
      <motion.article
        id={`msg-${message.id}`}
        className={stickerClassName}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
      >
        {stickerInner}
      </motion.article>
    );
  }
  // ─────────────────────────────────────────────────────────────────────

  const attachments = messageAttachments(message);
  const audioMsg = attachments.some((file) => isAudioAttachment(file));
  const mediaMsg = attachments.some((file) => isMediaAttachment(file));
  const soloSize =
    message.kind !== "file" && message.kind !== "invite" && !attachments.length
      ? soloEmojiSizePx(message.text)
      : 0;
  const bigEmoji = soloSize > 0;
  const skipTail =
    attachNext ||
    bigEmoji ||
    (mediaMsg && !hasVisibleMediaCaption(message));
  const bubbleShape = plaqueShapeClass(attachPrev, attachNext, skipTail);
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

  const textNode = renderMessageText(message.text, searchQuery);
  const soloGlyphs = bigEmoji
    ? splitTextAndEmoji(message.text)
        .filter((part) => part.type === "emoji")
        .map((part) => part.value)
    : [];

  const sendTime = (
    <SendMeta
      inline={!reactions && !bigEmoji}
      createdAt={message.createdAt}
      mine={mine}
      status={message.status}
      peerReadAt={peerReadAt}
    />
  );

  const body = (
    <>
      {hideAvatarColumn ? null : showAvatar ? (
        <Avatar name={author.name} src={author.avatarUrl} size="md" />
      ) : (
        <span className="bubble-row__spacer" aria-hidden />
      )}
      <div
        ref={bubbleRef}
        className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"} ${
          showMeta ? "" : "bubble--compact"
        } ${bubbleShape} ${mediaMsg ? "bubble--media" : ""} ${
          audioMsg ? "bubble--audio" : ""
        } ${bigEmoji ? "bubble--emoji" : ""} ${
          menuOpen ? "is-actions-open" : ""
        } ${message.status === "pending" ? "bubble--pending" : ""} ${
          message.status === "failed" ? "bubble--failed" : ""
        } ${message.uploadProgress !== undefined ? "bubble--uploading" : ""}`}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu();
        }}
      >
        {showMeta && !mine && (
          <div className="bubble__meta-line">
            <span className="bubble__author">{author.name}</span>
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
          <FileBody
            message={message}
            mine={mine}
            peerReadAt={peerReadAt}
            onOpenImage={onOpenImage}
            onTranscribe={onTranscribe}
            onCancelUpload={onCancelUpload}
          />
        ) : bigEmoji ? (
          <>
            {message.editedAt ? (
              <em className="bubble__edited">изменено</em>
            ) : null}
            <div className="bubble__emoji-line">
              <p
                className="bubble__text bubble__text--emoji"
                style={
                  { "--emoji-solo-size": `${soloSize}px` } as CSSProperties
                }
              >
                {soloGlyphs.map((glyph, index) => (
                  <span key={`${glyph}-${index}`} className="emoji-glyph">
                    {glyph}
                  </span>
                ))}
              </p>
              {sendTime}
            </div>
          </>
        ) : (
          <p className="bubble__text">
            {textNode}
            {message.editedAt ? (
              <em className="bubble__edited"> изменено</em>
            ) : null}
            {!reactions && sendTime}
          </p>
        )}

        {reactions}

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
        selectedReactions={selectedReactions}
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

  /* TG-style row: avatar at bottom of last message in a same-author streak */
  const className = `bubble-row bubble-row--plaque ${mine ? "bubble-row--mine" : ""} ${
    showMeta ? "" : "bubble-row--compact"
  } ${attachPrev ? "bubble-row--attach-prev" : ""} ${
    attachNext ? "bubble-row--attach-next" : ""
  } ${dimmed ? "is-dimmed" : ""} ${highlighted ? "is-flash" : ""}`;

  const touchProps = {
    title: "Удержите для действий",
    onDoubleClick: (event: { target: EventTarget }) => {
      const node = event.target instanceof Element ? event.target : null;
      if (node?.closest(".voice-bubble, .voice-transcript, .bubble__audio, button, a, [role='slider']")) {
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
