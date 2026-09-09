"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { Avatar } from "@/components/chat/Avatar";
import dynamic from "next/dynamic";

const AvatarCropDialog = dynamic(
  () => import("@/components/chat/AvatarCropDialog").then((mod) => mod.AvatarCropDialog),
  { ssr: false }
);
import {
  IconAttach,
  IconCamera,
  IconClose,
  IconDownload,
  IconImage,
  IconLogout,
  IconPlay,
  IconTrash,
  IconUsers,
} from "@/lib/icons";
import { formatBytes, bareMediaUrl, validateAvatarFile } from "@/lib/files";
import { easeOutSoft, sheetSpring } from "@/lib/motion";
import type {
  ChatInfo,
  GroupVisibility,
  RoomMediaItem,
} from "@/lib/types";

type Tab = "media" | "files";

type ChatInfoPanelProps = {
  open: boolean;
  chat: ChatInfo | null;
  canEditAvatar: boolean;
  canEditProfile?: boolean;
  canDeleteGroup?: boolean;
  canLeaveGroup?: boolean;
  uploading?: boolean;
  error?: string | null;
  onClose: () => void;
  onUploadAvatar: (file: File) => Promise<string | null>;
  onSaveAvatar: (avatarUrl: string | null) => Promise<boolean>;
  onSaveProfile?: (patch: {
    title?: string;
    topic?: string;
  }) => Promise<boolean>;
  onSaveVisibility?: (visibility: GroupVisibility) => Promise<boolean>;
  onFetchMedia: (
    kind: "media" | "file",
    offset: number,
  ) => Promise<{
    items: RoomMediaItem[];
    total: number;
    hasMore: boolean;
    error?: string;
  }>;
  onOpenMedia: (item: RoomMediaItem) => void;
  onDeleteGroup?: () => void | Promise<void>;
  onLeaveGroup?: () => void | Promise<void>;
};

export function ChatInfoPanel({
  open,
  chat,
  canEditAvatar,
  canEditProfile = false,
  canDeleteGroup = false,
  canLeaveGroup = false,
  uploading = false,
  error,
  onClose,
  onUploadAvatar,
  onSaveAvatar,
  onSaveProfile,
  onSaveVisibility,
  onFetchMedia,
  onOpenMedia,
  onDeleteGroup,
  onLeaveGroup,
}: ChatInfoPanelProps) {
  const [tab, setTab] = useState<Tab>("media");
  const [mediaItems, setMediaItems] = useState<RoomMediaItem[]>([]);
  const [fileItems, setFileItems] = useState<RoomMediaItem[]>([]);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [fileTotal, setFileTotal] = useState(0);
  const [mediaHasMore, setMediaHasMore] = useState(false);
  const [fileHasMore, setFileHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editTopic, setEditTopic] = useState("");
  const [editVisibility, setEditVisibility] =
    useState<GroupVisibility>("public");
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const fileInputId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const chatId = chat?.id;

  useEffect(() => {
    if (!chat) return;
    setEditTitle(chat.title || "");
    setEditTopic(chat.topic || "");
    setEditVisibility(chat.visibility === "private" ? "private" : "public");
  }, [chat?.id, chat?.title, chat?.topic, chat?.visibility]);

  const loadTab = useCallback(
    async (nextTab: Tab, reset: boolean) => {
      if (!chatId) return;
      const kind = nextTab === "media" ? "media" : "file";
      const offset = reset
        ? 0
        : nextTab === "media"
          ? mediaItems.length
          : fileItems.length;

      if (reset) setLoading(true);
      else setLoadingMore(true);
      setLocalError(null);

      try {
        const result = await onFetchMedia(kind, offset);
        if (result.error) setLocalError(result.error);
        if (nextTab === "media") {
          setMediaItems((prev) =>
            reset ? result.items : [...prev, ...result.items],
          );
          setMediaTotal(result.total);
          setMediaHasMore(result.hasMore);
        } else {
          setFileItems((prev) =>
            reset ? result.items : [...prev, ...result.items],
          );
          setFileTotal(result.total);
          setFileHasMore(result.hasMore);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [chatId, fileItems.length, mediaItems.length, onFetchMedia],
  );

  useEffect(() => {
    if (!open || !chatId) return;
    setTab("media");
    setMediaItems([]);
    setFileItems([]);
    setMediaTotal(0);
    setFileTotal(0);
    setMediaHasMore(false);
    setFileHasMore(false);
    setLocalError(null);
    closeRef.current?.focus();
    void loadTab("media", true);
    // Only reload when the panel opens for a chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chatId]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function handleTab(next: Tab) {
    setTab(next);
    if (next === "media" && mediaItems.length === 0) {
      await loadTab("media", true);
    }
    if (next === "files" && fileItems.length === 0) {
      await loadTab("files", true);
    }
  }

  function handleAvatarPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !canEditAvatar) return;
    const invalid = validateAvatarFile(file);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setLocalError(null);
    setCropFile(file);
  }

  async function uploadCroppedAvatar(file: File) {
    if (!canEditAvatar) return;
    setCropFile(null);
    setAvatarBusy(true);
    setLocalError(null);
    try {
      const url = await onUploadAvatar(file);
      if (!url) return;
      const ok = await onSaveAvatar(url);
      if (!ok) {
        setLocalError("Фото загружено, но аватар группы не сохранился");
      }
    } finally {
      setAvatarBusy(false);
    }
  }

  async function clearAvatar() {
    if (!canEditAvatar) return;
    setAvatarBusy(true);
    setLocalError(null);
    try {
      const ok = await onSaveAvatar(null);
      if (!ok) setLocalError("Не удалось убрать аватар");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function saveProfile() {
    if (!canEditProfile || !onSaveProfile) return;
    const nextTitle = editTitle.trim();
    if (!nextTitle) {
      setLocalError("Укажите название группы");
      return;
    }
    setProfileBusy(true);
    setLocalError(null);
    try {
      const ok = await onSaveProfile({
        title: nextTitle,
        topic: editTopic.trim(),
      });
      if (!ok) setLocalError("Не удалось сохранить название");
    } finally {
      setProfileBusy(false);
    }
  }

  async function saveVisibility(next: GroupVisibility) {
    if (!canEditProfile || !onSaveVisibility) return;
    setEditVisibility(next);
    setVisibilityBusy(true);
    setLocalError(null);
    try {
      const ok = await onSaveVisibility(next);
      if (!ok) {
        setEditVisibility(
          chat?.visibility === "private" ? "private" : "public",
        );
        setLocalError("Не удалось изменить доступ");
      }
    } finally {
      setVisibilityBusy(false);
    }
  }

  if (!chat) return null;

  const title = chat.type === "channel" ? `#${chat.title}` : chat.title;
  const groupAccessLabel =
    chat.visibility === "private" ? "Закрытая" : "Открытая";
  const eyebrow =
    chat.type === "channel"
      ? "Канал"
      : chat.type === "group"
        ? `Группа · ${groupAccessLabel}`
        : "Чат";
  const items = tab === "media" ? mediaItems : fileItems;
  const total = tab === "media" ? mediaTotal : fileTotal;
  const hasMore = tab === "media" ? mediaHasMore : fileHasMore;
  const busy = uploading || avatarBusy || profileBusy || visibilityBusy;
  const profileDirty =
    canEditProfile &&
    (editTitle.trim() !== (chat.title || "").trim() ||
      editTopic.trim() !== (chat.topic || "").trim());

  return (
    <AnimatePresence>
      {open && (
        <div className="chat-info">
          <motion.button
            type="button"
            className="chat-info__backdrop"
            aria-label="Закрыть"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: easeOutSoft }}
          />
          <motion.div
            className="chat-info__card"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.99 }}
            transition={sheetSpring}
          >
            <header className="chat-info__head">
              <div>
                <p className="chat-info__eyebrow">{eyebrow}</p>
                <h2>{title}</h2>
              </div>
              <button
                ref={closeRef}
                type="button"
                className="icon-btn"
                aria-label="Закрыть"
                onClick={onClose}
              >
                <IconClose />
              </button>
            </header>

            <div className="chat-info__hero">
              <div className="chat-info__avatar-wrap">
                <Avatar name={chat.title} src={chat.avatarUrl} size="lg" />
                {canEditAvatar && (
                  <>
                    <input
                      id={fileInputId}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      tabIndex={-1}
                      onChange={handleAvatarPick}
                      onClick={(event) => {
                        (event.target as HTMLInputElement).value = "";
                      }}
                    />
                    <label
                      htmlFor={fileInputId}
                      className={`chat-info__avatar-btn ${busy ? "is-disabled" : ""}`}
                      onClick={(event) => {
                        if (busy) event.preventDefault();
                      }}
                    >
                      <IconCamera size={16} />
                      {busy ? "Загрузка…" : "Фото"}
                    </label>
                    {chat.avatarUrl && (
                      <button
                        type="button"
                        className="chat-info__clear"
                        disabled={busy}
                        onClick={() => void clearAvatar()}
                      >
                        Убрать
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="chat-info__meta">
                {canEditProfile ? (
                  <div className="chat-info__edit">
                    <label className="chat-info__field">
                      <span>Название</span>
                      <input
                        value={editTitle}
                        maxLength={40}
                        disabled={busy}
                        onChange={(event) => setEditTitle(event.target.value)}
                        placeholder="Название группы"
                      />
                    </label>
                    <label className="chat-info__field">
                      <span>Описание</span>
                      <input
                        value={editTopic}
                        maxLength={120}
                        disabled={busy}
                        onChange={(event) => setEditTopic(event.target.value)}
                        placeholder="Краткое описание"
                      />
                    </label>
                    {onSaveVisibility && (
                      <fieldset className="chat-info__visibility">
                        <legend>Доступ</legend>
                        <label className="chat-info__visibility-option">
                          <input
                            type="radio"
                            name="chat-info-visibility"
                            checked={editVisibility === "public"}
                            disabled={busy}
                            onChange={() => void saveVisibility("public")}
                          />
                          <span>
                            <strong>Открытая</strong>
                            <em>В поиске у всех</em>
                          </span>
                        </label>
                        <label className="chat-info__visibility-option">
                          <input
                            type="radio"
                            name="chat-info-visibility"
                            checked={editVisibility === "private"}
                            disabled={busy}
                            onChange={() => void saveVisibility("private")}
                          />
                          <span>
                            <strong>Закрытая</strong>
                            <em>Только по приглашению</em>
                          </span>
                        </label>
                      </fieldset>
                    )}
                    <button
                      type="button"
                      className="chat-info__save"
                      disabled={busy || !profileDirty || !editTitle.trim()}
                      onClick={() => void saveProfile()}
                    >
                      {profileBusy ? "Сохранение…" : "Сохранить"}
                    </button>
                  </div>
                ) : (
                  <>
                    <p>{chat.topic || "Без описания"}</p>
                    {chat.type === "group" && (
                      <p className="chat-info__access">
                        {groupAccessLabel} группа
                      </p>
                    )}
                  </>
                )}
                <span>
                  <IconUsers size={14} />
                  {chat.members}{" "}
                  {chat.members === 1
                    ? "участник"
                    : chat.members < 5
                      ? "участника"
                      : "участников"}
                </span>
              </div>
            </div>

            <div className="chat-info__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "media"}
                className={tab === "media" ? "is-active" : ""}
                onClick={() => void handleTab("media")}
              >
                <IconImage size={15} />
                Медиа
                {mediaTotal > 0 ? ` · ${mediaTotal}` : ""}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "files"}
                className={tab === "files" ? "is-active" : ""}
                onClick={() => void handleTab("files")}
              >
                <IconAttach size={15} />
                Файлы
                {fileTotal > 0 ? ` · ${fileTotal}` : ""}
              </button>
            </div>

            <div className="chat-info__body" role="tabpanel">
              {loading ? (
                <p className="chat-info__empty">Загрузка…</p>
              ) : items.length === 0 ? (
                <p className="chat-info__empty">
                  {tab === "media"
                    ? "Пока нет фото и видео"
                    : "Пока нет файлов"}
                </p>
              ) : tab === "media" ? (
                <div className="chat-info__grid">
                  {items.map((item) => {
                    const src = bareMediaUrl(item.file.url);
                    return (
                    <button
                      key={item.messageId}
                      type="button"
                      className="chat-info__thumb"
                      onClick={() =>
                        onOpenMedia({
                          ...item,
                          file: { ...item.file, url: src },
                        })
                      }
                      aria-label={
                        item.kind === "video" ? "Открыть видео" : "Открыть фото"
                      }
                    >
                      { }
                      {item.kind === "video" ? (
                        <span className="chat-info__video-thumb">
                          <video
                            src={src}
                            muted
                            playsInline
                            preload="metadata"
                          />
                          <i>
                            <IconPlay size={18} />
                          </i>
                        </span>
                      ) : (
                        <img src={src} alt="" loading="lazy" decoding="async" />
                      )}
                    </button>
                    );
                  })}
                </div>
              ) : (
                <ul className="chat-info__files">
                  {items.map((item) => {
                    const href = `${item.file.url}${item.file.url.includes("?") ? "&" : "?"}download=1`;
                    return (
                      <li key={item.messageId}>
                        <div className="chat-info__file-meta">
                          <IconAttach size={16} />
                          <div>
                            <strong title={item.file.name}>
                              {item.file.name}
                            </strong>
                            <em>
                              {formatBytes(item.file.size)}
                              {item.category === "audio" ? " · аудио" : ""}
                              {item.author ? ` · ${item.author}` : ""}
                            </em>
                          </div>
                        </div>
                        <a
                          className="icon-btn"
                          href={href}
                          download={item.file.name}
                          aria-label="Скачать"
                          title="Скачать"
                        >
                          <IconDownload size={16} />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}

              {hasMore && (
                <button
                  type="button"
                  className="chat-info__more"
                  disabled={loadingMore}
                  onClick={() => void loadTab(tab, false)}
                >
                  {loadingMore
                    ? "Загрузка…"
                    : `Ещё · ${Math.max(total - items.length, 0)}`}
                </button>
              )}
            </div>

            {(localError || error) && (
              <p className="chat-info__error">{localError || error}</p>
            )}

            {canLeaveGroup && onLeaveGroup && (
              <button
                type="button"
                className="chat-info__danger"
                disabled={busy}
                onClick={() => void onLeaveGroup()}
              >
                <IconLogout size={16} />
                Выйти из группы
              </button>
            )}

            {canDeleteGroup && onDeleteGroup && (
              <button
                type="button"
                className="chat-info__danger"
                disabled={busy}
                onClick={() => void onDeleteGroup()}
              >
                <IconTrash size={16} />
                Удалить группу
              </button>
            )}
          </motion.div>
        </div>
      )}
      <AvatarCropDialog
        open={Boolean(cropFile)}
        file={cropFile}
        onCancel={() => setCropFile(null)}
        onComplete={(file) => {
          void uploadCroppedAvatar(file);
        }}
      />
    </AnimatePresence>
  );
}
