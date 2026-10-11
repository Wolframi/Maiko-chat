"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import TextareaAutosize from "react-textarea-autosize";
import { IconAttach, IconClose, IconMic, IconSend } from "@/lib/icons";
import {
  formatBytes,
  isMediaAttachment,
  isVideoAttachment,
  MAX_PENDING_FILES,
  parseMediaSize,
  validateFile,
} from "@/lib/files";
import { clearDraft, loadDraft, saveDraft } from "@/lib/drafts";
import {
  CANCEL_SLIDE_PX,
  VoiceRecorderBar,
  type VoiceRecorderControls,
} from "@/components/chat/VoiceRecorderBar";
import { MentionMenu } from "@/components/chat/MentionMenu";
import { UnifiedPicker } from "@/components/chat/UnifiedPicker";
import type { FileAttachment, PeopleUser, StickerPack } from "@/lib/types";
import { toast } from "sonner";
import { parseGiphyMediaUrl } from "@/lib/giphyMedia";

type PendingFile = {
  id: string;
  file: File;
  previewUrl?: string;
};

type ReplyDraft = {
  id: string;
  author: string;
  text: string;
};

type ComposerProps = {
  onSend: (text: string, replyToId?: string) => boolean | void;
  onSendFiles: (
    files: File[],
    options?: {
      caption?: string;
      replyToId?: string;
    },
  ) => Promise<{ ok: boolean; completed: File[] }>;
  onSendRemoteFile?: (
    file: FileAttachment,
    options?: { caption?: string; replyToId?: string },
  ) => Promise<boolean>;
  onTyping: (isTyping: boolean) => void;
  disabled?: boolean;
  error?: string | null;
  onClearError?: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  focusToken?: string | number;
  onAttachmentsCleared?: () => void;
  mentionMembers?: PeopleUser[];
  editingText?: string | null;
  onCancelEdit?: () => void;
  userId?: string;
  token?: string;

  /* ─── Стикеры ─────────────────────────────────────────── */
  stickerPacks: StickerPack[];
  refreshStickerPacks: () => Promise<StickerPack[]>;
  onCreateStickerPack: (
    title: string,
  ) => Promise<{ ok: boolean; pack?: StickerPack; error?: string }>;
  onDeleteStickerPack: (packId: string) => Promise<boolean>;
  onRenameStickerPack: (packId: string, title: string) => Promise<boolean>;
  onAddSticker: (
    packId: string,
    file: File,
    extra?: { emoji?: string; width?: number; height?: number; animated?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  onRemoveSticker: (packId: string, stickerId: string) => Promise<boolean>;
  onStickerPick?: (packId: string, stickerId: string) => void;
  /** During a compact group call, render the picker in this column instead of over the composer. */
  pickerPortalRoot?: HTMLElement | null;
  onPickerOpenChange?: (open: boolean) => void;
  /* ─────────────────────────────────────────────────────── */
};

export function Composer({
  onSend,
  onSendFiles,
  onSendRemoteFile,
  onTyping,
  disabled = false,
  error,
  onClearError,
  replyTo = null,
  onClearReply,
  focusToken,
  onAttachmentsCleared,
  mentionMembers = [],
  editingText = null,
  onCancelEdit,
  userId = "",
  token = "",
  stickerPacks,
  refreshStickerPacks,
  onCreateStickerPack,
  onDeleteStickerPack,
  onRenameStickerPack,
  onAddSticker,
  onRemoveSticker,
  onStickerPick,
  pickerPortalRoot = null,
  onPickerOpenChange,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const [sentPulse, setSentPulse] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState<"hold" | "click">("hold");
  const [voiceSlideX, setVoiceSlideX] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    onPickerOpenChange?.(pickerOpen);
  }, [onPickerOpenChange, pickerOpen]);
  const [composerEl, setComposerEl] = useState<HTMLFormElement | null>(null);

  const typingRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);
  const voiceControlsRef = useRef<VoiceRecorderControls | null>(null);
  const pendingVoiceActionRef = useRef<"finish" | "cancel" | null>(null);
  const voiceGestureRef = useRef<{
    pointerId: number;
    startX: number;
    cancelled: boolean;
  } | null>(null);
  const suppressMicClickRef = useRef(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputId = useId();
  const dragDepth = useRef(0);
  const textRef = useRef("");
  const pendingRef = useRef<PendingFile[]>([]);
  const draftsRef = useRef(new Map<string, string>());
  const chatKeyRef = useRef("");
  const locked = disabled;

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (typingRef.current) onTyping(false);
      const key = chatKeyRef.current;
      if (key) saveDraft(key, textRef.current);
      pendingRef.current.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, [onTyping]);

  // Смена чата: сохранение/загрузка черновика
  useEffect(() => {
    if (focusToken === undefined) return;
    const key = String(focusToken);
    const prev = chatKeyRef.current;

    if (prev && prev !== key) {
      draftsRef.current.set(prev, textRef.current);
      saveDraft(prev, textRef.current);
      setPending((items) => {
        if (items.length) onAttachmentsCleared?.();
        items.forEach((item) => {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        });
        return [];
      });
      setLocalError(null);
      const restored = draftsRef.current.get(key) ?? loadDraft(key);
      draftsRef.current.set(key, restored);
      setText(restored);
      setVoiceOpen(false);
      setPickerOpen(false);
      if (typingRef.current) {
        typingRef.current = false;
        onTyping(false);
      }
    } else if (!prev) {
      const restored =
        draftsRef.current.get(key) ?? loadDraft(key) ?? textRef.current;
      draftsRef.current.set(key, restored);
      setText(restored);
    }

    chatKeyRef.current = key;
  }, [focusToken, onTyping, onAttachmentsCleared]);

  useEffect(() => {
    if (focusToken === undefined) return;
    const node = areaRef.current;
    if (!node) return;
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, [focusToken, replyTo?.id]);

  const pendingFiles = useMemo(
    () => pending.map((item) => item.file),
    [pending],
  );
  const shownError = localError || error;

  const flashError = useCallback((msg: string) => {
    setLocalError(msg);
    setErrorTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!shownError) return;
    const timer = window.setTimeout(() => {
      setLocalError(null);
      onClearError?.();
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [shownError, errorTick, onClearError]);

  function addFiles(list: FileList | File[]) {
    const incoming = [...list];
    if (!incoming.length) return;
    onClearError?.();
    setLocalError(null);

    setPending((prev) => {
      const room = Math.max(0, MAX_PENDING_FILES - prev.length);
      if (room === 0) {
        flashError(
          `Можно прикрепить не больше ${MAX_PENDING_FILES} файлов`,
        );
        return prev;
      }

      const nextItems: PendingFile[] = [];
      let errorMsg: string | null = null;

      for (const file of incoming) {
        if (nextItems.length >= room) {
          errorMsg =
            errorMsg ||
            `Можно прикрепить не больше ${MAX_PENDING_FILES} файлов`;
          break;
        }
        const invalid = validateFile(file);
        if (invalid) {
          errorMsg = errorMsg || `${file.name}: ${invalid}`;
          continue;
        }
        nextItems.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
          file,
          previewUrl:
            file.type.startsWith("image/") ||
            file.type.startsWith("video/") ||
            /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(file.name)
              ? URL.createObjectURL(file)
              : undefined,
        });
      }

      if (errorMsg) flashError(errorMsg);
      return [...prev, ...nextItems].slice(0, MAX_PENDING_FILES);
    });
  }

  function removePending(id: string) {
    setPending((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  }

  function persistDraft(value: string) {
    const key = chatKeyRef.current;
    if (!key) return;
    draftsRef.current.set(key, value);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => saveDraft(key, value), 280);
  }

  useEffect(() => {
    if (editingText == null) return;
    setText(editingText);
    setVoiceOpen(false);
    setPickerOpen(false);
    requestAnimationFrame(() => {
      const node = areaRef.current;
      if (!node) return;
      node.focus();
      const end = node.value.length;
      node.setSelectionRange(end, end);
    });
  }, [editingText]);

  function updateMentionState(next: string, caret = next.length) {
    const before = next.slice(0, caret);
    const match = before.match(/(^|\s)@([^\s@]*)$/);
    if (!match || !mentionMembers.length) {
      setMentionOpen(false);
      setMentionQuery("");
      setMentionStart(null);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(match[2] || "");
    setMentionStart(caret - (match[2] || "").length - 1);
    setMentionIndex(0);
  }

  function applyMention(user: PeopleUser) {
    if (mentionStart == null) return;
    const caret = areaRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, mentionStart);
    const after = text.slice(caret);
    const token = `@${user.username} `;
    const next = `${before}${token}${after}`.slice(0, 2000);
    markTyping(next);
    setMentionOpen(false);
    setMentionStart(null);
    requestAnimationFrame(() => {
      const node = areaRef.current;
      if (!node) return;
      const pos = before.length + token.length;
      node.focus();
      node.setSelectionRange(pos, pos);
    });
  }

  function markTyping(next: string) {
    setText(next);
    persistDraft(next);
    onClearError?.();
    setLocalError(null);

    const caret = areaRef.current?.selectionStart ?? next.length;
    updateMentionState(next, caret);

    if (next.trim() && !typingRef.current) {
      typingRef.current = true;
      onTyping(true);
    }

    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (typingRef.current) {
        typingRef.current = false;
        onTyping(false);
      }
    }, 1200);

    if (!next.trim() && typingRef.current) {
      typingRef.current = false;
      onTyping(false);
    }
  }

  function pulseSend() {
    setSentPulse(true);
    window.setTimeout(() => setSentPulse(false), 280);
  }

  // Вставка эмодзи
  const handleEmojiInsert = useCallback(
    (emoji: string) => {
      const area = areaRef.current;
      const start = area?.selectionStart ?? text.length;
      const end = area?.selectionEnd ?? text.length;
      const next = `${text.slice(0, start)}${emoji}${text.slice(end)}`.slice(
        0,
        2000,
      );
      markTyping(next);
      requestAnimationFrame(() => {
        const node = areaRef.current;
        if (!node) return;
        const caret = Math.min(start + emoji.length, next.length);
        node.focus();
        node.setSelectionRange(caret, caret);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text],
  );

  // Отправка GIF
  const handleGifSend = useCallback(
    async (url: string, size?: { width: number; height: number }) => {
      if (locked || sendingRef.current) return;
      sendingRef.current = true;
      try {
        const remote = parseGiphyMediaUrl(url);
        const pixels = parseMediaSize(size);
        if (remote && onSendRemoteFile) {
          const ok = await onSendRemoteFile(
            {
              url: remote.url,
              name: remote.name,
              mime: remote.mime,
              size: remote.size,
              ...pixels,
            },
            { caption: "", replyToId: replyTo?.id },
          );
          if (ok) {
            onClearReply?.();
            pulseSend();
            setPickerOpen(false);
            return;
          }
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error(`Ошибка ${res.status}`);
        const blob = await res.blob();
        const contentType = blob.type || "image/gif";
        const ext = contentType.includes("webp")
          ? "webp"
          : contentType.includes("png")
            ? "png"
            : "gif";
        const file = new File([blob], `gif-${Date.now()}.${ext}`, {
          type: contentType,
        });
        const uploaded = await onSendFiles([file], {
          caption: "",
          replyToId: replyTo?.id,
        });
        if (!uploaded.ok) throw new Error("upload failed");
        onClearReply?.();
        pulseSend();
        setPickerOpen(false);
      } catch {
        toast.error("Не удалось отправить GIF");
      } finally {
        sendingRef.current = false;
      }
    },
    [locked, onSendFiles, onSendRemoteFile, replyTo?.id, onClearReply],
  );

  async function submit() {
    if (locked || sendingRef.current) return;

    const chatKeyAtStart = chatKeyRef.current;

    if (pendingFiles.length) {
      sendingRef.current = true;
      const caption = text.trim();
      const items = [...pending];
      // Files leave the composer at once; progress lives in the chat bubble.
      setPending([]);
      setText("");
      if (chatKeyAtStart) {
        draftsRef.current.set(chatKeyAtStart, "");
        clearDraft(chatKeyAtStart);
      }
      if (typingRef.current) {
        typingRef.current = false;
        onTyping(false);
      }
      try {
        const result = await onSendFiles(
          items.map((item) => item.file),
          { caption, replyToId: replyTo?.id },
        );

        const done = new Set(result.completed);
        const restore = items.filter((item) => !done.has(item.file));
        items.forEach((item) => {
          if (done.has(item.file) && item.previewUrl) {
            URL.revokeObjectURL(item.previewUrl);
          }
        });

        if (!result.ok && chatKeyRef.current === chatKeyAtStart) {
          setPending((prev) =>
            [...restore, ...prev].slice(0, MAX_PENDING_FILES),
          );
          if (!textRef.current && caption) {
            setText(caption);
            persistDraft(caption);
          }
          return;
        }
        restore.forEach((item) => {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        });
        if (!result.ok) return;

        onClearReply?.();
        pulseSend();
      } finally {
        sendingRef.current = false;
      }
      return;
    }

    if (!text.trim()) return;
    const sent = onSend(text, replyTo?.id);
    if (sent === false) return;
    setText("");
    if (focusToken !== undefined) {
      const key = String(focusToken);
      draftsRef.current.set(key, "");
      clearDraft(key);
    }
    onClearReply?.();
    pulseSend();
    if (typingRef.current) {
      typingRef.current = false;
      onTyping(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && editingText != null) {
      event.preventDefault();
      onCancelEdit?.();
      return;
    }
    if (event.key === "Escape" && replyTo) {
      event.preventDefault();
      onClearReply?.();
      return;
    }
    if (event.key === "Escape" && pickerOpen) {
      event.preventDefault();
      setPickerOpen(false);
      return;
    }
    if (mentionOpen) {
      const filtered = mentionMembers
        .filter((user) => {
          const q = mentionQuery.trim().toLowerCase();
          if (!q) return true;
          return (
            user.displayName.toLowerCase().includes(q) ||
            user.username.toLowerCase().includes(q)
          );
        })
        .slice(0, 8);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i) =>
          Math.min(i + 1, Math.max(0, filtered.length - 1)),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const pick = filtered[mentionIndex];
        if (pick) {
          event.preventDefault();
          applyMention(pick);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (!files.length) return;
    addFiles(files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  }

  function handleDragEnter(event: DragEvent) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent) {
    event.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files?.length) {
      addFiles(event.dataTransfer.files);
    }
  }

  const canSend = Boolean(text.trim() || pendingFiles.length) && !locked;
  const showMic = !canSend && !voiceOpen && !locked;
  function closeVoiceUi() {
    setVoiceOpen(false);
    setVoiceSlideX(0);
    setVoiceMode("hold");
    voiceControlsRef.current = null;
    voiceGestureRef.current = null;
    pendingVoiceActionRef.current = null;
  }

  function openVoiceClick() {
    if (suppressMicClickRef.current) {
      suppressMicClickRef.current = false;
      return;
    }
    if (locked || voiceOpen) return;
    onClearError?.();
    setLocalError(null);
    setPickerOpen(false);
    setVoiceMode("click");
    setVoiceSlideX(0);
    setVoiceOpen(true);
  }

  async function sendVoice(file: File) {
    if (locked || sendingRef.current) return;
    sendingRef.current = true;
    closeVoiceUi();
    onClearError?.();
    setLocalError(null);
    try {
      const result = await onSendFiles([file], {
        caption: "Голосовое сообщение",
        replyToId: replyTo?.id,
      });
      if (!result.ok) return;
      onClearReply?.();
      pulseSend();
    } finally {
      sendingRef.current = false;
    }
  }

  const bindVoiceControls = useCallback((controls: VoiceRecorderControls) => {
    voiceControlsRef.current = controls;
    const pending = pendingVoiceActionRef.current;
    if (!pending) return;
    pendingVoiceActionRef.current = null;
    if (pending === "cancel") controls.cancel();
    else controls.finish();
  }, []);

  function endVoiceGesture(cancelled: boolean) {
    voiceGestureRef.current = null;
    setVoiceSlideX(0);
    const action = cancelled ? "cancel" : "finish";
    const controls = voiceControlsRef.current;
    if (controls) {
      pendingVoiceActionRef.current = null;
      if (cancelled) controls.cancel();
      else controls.finish();
      return;
    }
    pendingVoiceActionRef.current = action;
  }

  function handleMicPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (locked || voiceOpen) return;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    event.preventDefault();
    suppressMicClickRef.current = true;
    onClearError?.();
    setLocalError(null);
    setPickerOpen(false);

    const pointerId = event.pointerId;
    const startX = event.clientX;
    voiceGestureRef.current = { pointerId, startX, cancelled: false };
    setVoiceMode("hold");
    setVoiceSlideX(0);
    setVoiceOpen(true);

    function onMove(ev: PointerEvent) {
      const gesture = voiceGestureRef.current;
      if (!gesture || ev.pointerId !== gesture.pointerId) return;
      const dx = ev.clientX - gesture.startX;
      const slide = Math.min(0, dx);
      setVoiceSlideX(slide);
      gesture.cancelled = slide <= -CANCEL_SLIDE_PX;
    }

    function onUp(ev: PointerEvent) {
      const gesture = voiceGestureRef.current;
      if (!gesture || ev.pointerId !== gesture.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      endVoiceGesture(gesture.cancelled);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  return (
    <form
      ref={setComposerEl}
      className={`composer ${dragging ? "composer--drag" : ""} ${disabled ? "is-disabled" : ""} ${pickerOpen ? "composer--picker" : ""}`}
      onSubmit={handleSubmit}
      onDragEnter={locked ? undefined : handleDragEnter}
      onDragLeave={locked ? undefined : handleDragLeave}
      onDragOver={locked ? undefined : handleDragOver}
      onDrop={locked ? undefined : handleDrop}
    >
      {dragging && <div className="composer__drop">Отпустите файлы здесь</div>}

      {replyTo && (
        <div className="composer__reply">
          <div>
            <strong>Ответ · {replyTo.author}</strong>
            <span>
              {replyTo.text.length > 140
                ? `${replyTo.text.slice(0, 139)}…`
                : replyTo.text}
            </span>
          </div>
          <button
            type="button"
            aria-label="Отменить ответ"
            onClick={onClearReply}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

      {editingText != null && (
        <div className="composer__reply composer__reply--edit">
          <div>
            <strong>Редактирование</strong>
            <span>Измените текст и отправьте</span>
          </div>
          <button
            type="button"
            aria-label="Отменить редактирование"
            onClick={onCancelEdit}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

      <MentionMenu
        open={mentionOpen && !locked}
        query={mentionQuery}
        members={mentionMembers}
        activeIndex={mentionIndex}
        onPick={applyMention}
        onHover={setMentionIndex}
      />

      {pending.length > 0 && (
        <div className="composer__pending">
          {pending.map((item) => {
            const media = isMediaAttachment({
              mime: item.file.type,
              name: item.file.name,
            });
            const video = isVideoAttachment({
              mime: item.file.type,
              name: item.file.name,
            });
            return (
              <div
                key={item.id}
                className={`composer__chip ${media ? "composer__chip--media" : ""}`}
              >
                {item.previewUrl ? (
                  video ? (
                    <video
                      src={item.previewUrl}
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.previewUrl} alt="" />
                  )
                ) : (
                  <span className="composer__chip-icon" aria-hidden>
                    <IconAttach size={14} />
                  </span>
                )}
                {!media && (
                  <span className="composer__chip-meta">
                    <strong>{item.file.name}</strong>
                    <em>{formatBytes(item.file.size)}</em>
                  </span>
                )}
                <button
                  type="button"
                  className="composer__chip-remove"
                  aria-label="Убрать файл"
                  disabled={locked}
                  onClick={() => removePending(item.id)}
                >
                  <IconClose size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {shownError && (
        <p
          key={`${shownError}-${errorTick}`}
          className="composer__hint"
          role="status"
          aria-live="polite"
        >
          {shownError}
        </p>
      )}

      {voiceOpen ? (
        <div className="composer__box composer__box--voice">
          <VoiceRecorderBar
            mode={voiceMode}
            disabled={locked}
            slideX={voiceMode === "hold" ? voiceSlideX : 0}
            onControls={bindVoiceControls}
            onCancel={closeVoiceUi}
            onReady={(file) => {
              void sendVoice(file);
            }}
          />
        </div>
      ) : (
        <div className={`composer__box ${locked ? "is-busy" : ""}`}>
          <input
            id={fileInputId}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={handleFile}
            onClick={(event) => {
              (event.target as HTMLInputElement).value = "";
            }}
          />
          <button
            type="button"
            disabled={locked || pending.length >= MAX_PENDING_FILES}
            className={`composer__attach ${
              locked || pending.length >= MAX_PENDING_FILES
                ? "is-disabled"
                : ""
            }`}
            aria-label="Прикрепить файл или фото"
            title="Файл или фото"
            onClick={(event) => {
              if (locked || pending.length >= MAX_PENDING_FILES) {
                event.preventDefault();
                return;
              }
              document.getElementById(fileInputId)?.click();
            }}
          >
            <IconAttach size={24} />
          </button>

          <TextareaAutosize
            ref={areaRef}
            className="composer__input"
            value={text}
            onChange={(event) => markTyping(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onPointerDown={() => {
              if (
                pickerOpen &&
                typeof window !== "undefined" &&
                window.matchMedia("(max-width: 640px)").matches
              ) {
                setPickerOpen(false);
              }
            }}
            onFocus={() => {
              if (
                pickerOpen &&
                typeof window !== "undefined" &&
                window.matchMedia("(max-width: 640px)").matches
              ) {
                setPickerOpen(false);
              }
            }}
            placeholder={
              disabled
                ? "Открываем чат…"
                : pending.length
                  ? "Подпись к файлу (необязательно)"
                  : "Написать сообщение…"
            }
            maxLength={2000}
            minRows={1}
            maxRows={5}
            autoComplete="off"
            disabled={locked}
          />

          {/* Единый пикер: эмодзи, GIF, стикеры */}
          <UnifiedPicker
            open={pickerOpen}
            portalRoot={pickerPortalRoot ?? composerEl}
            onRevealKeyboard={() => {
              areaRef.current?.focus();
            }}
            onOpenChange={(next) => {
              if (locked && next) return;
              if (
                next &&
                typeof window !== "undefined" &&
                window.matchMedia("(max-width: 640px)").matches
              ) {
                areaRef.current?.blur();
              }
              setPickerOpen(next);
            }}
            onEmojiPick={handleEmojiInsert}
            onGifPick={handleGifSend}
            onStickerPick={(packId, stickerId) => {
              onStickerPick?.(packId, stickerId);
              setPickerOpen(false);
            }}
            userId={userId}
            token={token}
            stickerPacks={stickerPacks}
            refreshStickerPacks={refreshStickerPacks}
            onCreateStickerPack={onCreateStickerPack}
            onDeleteStickerPack={onDeleteStickerPack}
            onRenameStickerPack={onRenameStickerPack}
            onAddSticker={onAddSticker}
            onRemoveSticker={onRemoveSticker}
          />

          {text.length > 1600 && (
            <span
              className={`composer__count ${
                text.length > 1900 ? "is-warn" : ""
              }`}
              aria-live="polite"
            >
              {2000 - text.length}
            </span>
          )}

          {showMic ? (
            <button
              type="button"
              className="composer__mic"
              aria-label="Записать голосовое"
              title="Голосовое сообщение"
              disabled={locked}
              onPointerDown={handleMicPointerDown}
              onClick={openVoiceClick}
              onContextMenu={(event) => event.preventDefault()}
            >
              <IconMic size={24} />
            </button>
          ) : (
            <button
              className={`composer__send ${
                sentPulse ? "is-sent" : ""
              } ${canSend ? "is-ready" : "is-idle"}`}
              type="submit"
              disabled={!canSend}
              aria-label="Отправить"
            >
              <IconSend size={24} />
            </button>
          )}
        </div>
      )}
    </form>
  );
}
