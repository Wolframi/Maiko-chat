"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AuthAccount } from "@/lib/types";
import { Avatar } from "@/components/chat/Avatar";
import { ConfirmDialog } from "@/components/chat/ConfirmDialog";
import dynamic from "next/dynamic";

const AvatarCropDialog = dynamic(
  () => import("@/components/chat/AvatarCropDialog").then((mod) => mod.AvatarCropDialog),
  { ssr: false }
);

const RingtoneTrimDialog = dynamic(
  () => import("@/components/chat/RingtoneTrimDialog").then((mod) => mod.RingtoneTrimDialog),
  { ssr: false }
);
import {
  IconCamera,
  IconClose,
  IconFileAudio,
  IconLogout,
  IconPause,
  IconPlay,
  IconTrash,
  IconUpload,
} from "@/lib/icons";
import { validateAvatarFile } from "@/lib/files";
import { sheetSpring, easeOutSoft } from "@/lib/motion";
import {
  ensureNotifyPermission,
  getNotifyCapabilityHint,
  getNotifyPermission,
  getSoundEnabled,
  setSoundEnabled,
  subscribeWebPush,
  type NotifyPermission,
} from "@/lib/notify";
import {
  fetchRingtoneCatalog,
  getRingtonePlayUrl,
  getSavedRingtone,
  previewRingtone,
  previewRingtoneFrom,
  setSavedRingtone,
  type CatalogRingtone,
  type SavedRingtone,
} from "@/lib/ringtone";
import {
  CUSTOM_RINGTONE_ID,
  CUSTOM_RINGTONE_URL,
  clearCustomRingtone,
  hasCustomRingtone,
  loadCustomSource,
  saveCustomRingtone,
  validateRingtoneFile,
} from "@/lib/customRingtone";
import { VoiceSettings } from "@/components/chat/VoiceSettings";

type ProfilePanelProps = {
  open: boolean;
  account: AuthAccount;
  connected: boolean;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (patch: {
    displayName: string;
    bio: string;
    avatarUrl?: string | null;
  }) => void | Promise<boolean | void>;
  onUploadAvatar: (file: File) => Promise<string | null>;
  onLogout: () => void;
};

export function ProfilePanel({
  open,
  account,
  connected,
  saving = false,
  error,
  onClose,
  onSave,
  onUploadAvatar,
  onLogout,
}: ProfilePanelProps) {
  const [displayName, setDisplayName] = useState(account.displayName);
  const [bio, setBio] = useState(account.bio || "");
  const [avatarUrl, setAvatarUrl] = useState(account.avatarUrl || "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [notifyPerm, setNotifyPerm] =
    useState<NotifyPermission>("unsupported");
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [ringtone, setRingtone] = useState<SavedRingtone | null>(null);
  const [catalog, setCatalog] = useState<CatalogRingtone[]>([]);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogPages, setCatalogPages] = useState(1);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [hasCustom, setHasCustom] = useState(false);
  const [customTitle, setCustomTitle] = useState("Свой рингтон");
  const [trimFile, setTrimFile] = useState<File | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [confirmDeleteCustom, setConfirmDeleteCustom] = useState(false);
  const [tab, setTab] = useState<"account" | "voice" | "ringtone">("account");
  const stopPreviewRef = useRef<(() => void) | null>(null);
  const fileInputId = useId();
  const ringtoneInputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  function stopPreview() {
    stopPreviewRef.current?.();
    stopPreviewRef.current = null;
    setPreviewId(null);
  }

  async function loadCatalog(page: number) {
    setCatalogLoading(true);
    setCatalogError(null);
    stopPreview();
    try {
      const data = await fetchRingtoneCatalog(page);
      setCatalog(data.items);
      setCatalogPage(data.page);
      setCatalogPages(Math.max(1, data.pages));
    } catch {
      setCatalogError("Не удалось загрузить каталог");
    } finally {
      setCatalogLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setDisplayName(account.displayName);
    setBio(account.bio || "");
    setAvatarUrl(account.avatarUrl || "");
    setLocalError(null);
    setSoundOn(getSoundEnabled());
    setNotifyPerm(getNotifyPermission());
    const saved = getSavedRingtone();
    setRingtone(saved);
    if (saved?.id === CUSTOM_RINGTONE_ID) setCustomTitle(saved.title);
    void hasCustomRingtone().then(setHasCustom);
    setCatalogError(null);
    setCatalog([]);
    setCatalogPage(1);
    setCatalogPages(1);
    setConfirmDeleteCustom(false);
    setTab("account");
    closeRef.current?.focus();
    void loadCatalog(1);
    return () => {
      stopPreview();
    };
  }, [open, account]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (trimFile || cropFile || confirmDeleteCustom) return;
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, trimFile, cropFile, confirmDeleteCustom]);

  function handleRingtonePick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const invalid = validateRingtoneFile(file);
    if (invalid) {
      setCatalogError(invalid);
      return;
    }
    setCatalogError(null);
    stopPreview();
    setTrimStart(0);
    setTrimEnd(0);
    setTrimFile(file);
  }

  async function openCustomTrim() {
    const source = await loadCustomSource();
    if (!source) {
      ringtoneInputRef.current?.click();
      return;
    }
    stopPreview();
    setTrimStart(source.startSec);
    setTrimEnd(source.endSec);
    setTrimFile(source.file);
  }

  async function applyCustomRingtone(payload: {
    trimmed: Blob;
    source: File;
    title: string;
    startSec: number;
    endSec: number;
  }) {
    await saveCustomRingtone({
      trimmed: payload.trimmed,
      source: payload.source,
      sourceName: payload.source.name,
      startSec: payload.startSec,
      endSec: payload.endSec,
      title: payload.title,
    });
    const next: SavedRingtone = {
      id: CUSTOM_RINGTONE_ID,
      title: payload.title,
      url: CUSTOM_RINGTONE_URL,
      startSec: 0,
    };
    setSavedRingtone(next);
    setRingtone(next);
    setCustomTitle(payload.title);
    setHasCustom(true);
    setTrimFile(null);
  }

  async function removeCustomRingtone() {
    stopPreview();
    try {
      await clearCustomRingtone();
      if (getSavedRingtone()?.id === CUSTOM_RINGTONE_ID) {
        setSavedRingtone(null);
        setRingtone(null);
      }
      setHasCustom(false);
      setCustomTitle("Свой рингтон");
      setCatalogError(null);
    } catch {
      setCatalogError("Не удалось удалить рингтон");
    } finally {
      setConfirmDeleteCustom(false);
    }
  }

  async function previewSaved(item: SavedRingtone) {
    stopPreview();
    setPreviewId(item.id);
    setCatalogError(null);
    const url = await getRingtonePlayUrl(item);
    stopPreviewRef.current = previewRingtoneFrom(url, item.startSec || 0, () => {
      setPreviewId(null);
      setCatalogError("Не удалось воспроизвести рингтон");
    });
  }

  function handleAvatarPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const invalid = validateAvatarFile(file);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setLocalError(null);
    setCropFile(file);
  }

  async function uploadCroppedAvatar(file: File) {
    setCropFile(null);
    setUploading(true);
    setLocalError(null);
    try {
      const url = await onUploadAvatar(file);
      if (!url) {
        // Parent sets a more specific profile error.
        return;
      }
      setAvatarUrl(url);
      // Persist immediately so a successful upload isn't lost if the panel closes.
      const ok = await onSave({
        displayName,
        bio,
        avatarUrl: url,
      });
      if (ok === false) {
        setLocalError(
          "Фото загружено, но профиль не сохранился — нажмите Сохранить",
        );
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    const ok = await onSave({
      displayName,
      bio,
      avatarUrl: avatarUrl || null,
    });
    if (ok !== false) onClose();
  }

  const previewName = displayName.trim() || account.username;

  return (
    <>
    <AnimatePresence>
      {open && (
        <div key="profile" className="profile">
          <motion.button
            type="button"
            className="profile__backdrop"
            aria-label="Закрыть профиль"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: easeOutSoft }}
          />
          <motion.div
            className="profile__card"
            role="dialog"
            aria-modal="true"
            aria-label="Профиль"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.99 }}
            transition={sheetSpring}
          >
            <header className="profile__head">
              <div>
                <p className="profile__eyebrow">Профиль</p>
                <h2>
                  {tab === "ringtone"
                    ? "Рингтон"
                    : tab === "voice"
                      ? "Голос и звук"
                      : "Ваш аккаунт"}
                </h2>
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

            <div className="profile__tabs" role="tablist" aria-label="Разделы профиля">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "account"}
                className={`profile__tab ${tab === "account" ? "is-active" : ""}`}
                onClick={() => {
                  stopPreview();
                  setTab("account");
                }}
              >
                Аккаунт
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "voice"}
                className={`profile__tab ${tab === "voice" ? "is-active" : ""}`}
                onClick={() => {
                  stopPreview();
                  setTab("voice");
                }}
              >
                Голос
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "ringtone"}
                className={`profile__tab ${tab === "ringtone" ? "is-active" : ""}`}
                onClick={() => setTab("ringtone")}
              >
                Рингтон
              </button>
            </div>

            {tab === "voice" ? (
              <VoiceSettings />
            ) : tab === "ringtone" ? (
              <section
                className="profile__ringtone profile__ringtone--tab"
                aria-label="Рингтон"
              >
                <p className="profile__ringtone-now" title={ringtone?.title}>
                  Сейчас:{" "}
                  <strong>
                    {ringtone ? ringtone.title : "стандартный сигнал"}
                  </strong>
                </p>

                <div className="profile__ringtone-custom">
                  <input
                    ref={ringtoneInputRef}
                    type="file"
                    accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac"
                    hidden
                    onChange={handleRingtonePick}
                  />
                  <button
                    type="button"
                    className="profile__ringtone-upload"
                    onClick={() => ringtoneInputRef.current?.click()}
                  >
                    <IconUpload size={14} />
                    Загрузить свой
                  </button>
                  {hasCustom ? (
                    <button
                      type="button"
                      className="profile__ringtone-upload profile__ringtone-upload--ghost"
                      onClick={() => void openCustomTrim()}
                    >
                      <IconFileAudio size={14} />
                      Обрезать
                    </button>
                  ) : null}
                  {hasCustom ? (
                    <button
                      type="button"
                      className="profile__ringtone-upload profile__ringtone-upload--danger"
                      onClick={() => {
                        stopPreview();
                        setConfirmDeleteCustom(true);
                      }}
                    >
                      <IconTrash size={14} />
                      Удалить
                    </button>
                  ) : null}
                </div>

                <div className="profile__ringtone-pager">
                  <button
                    type="button"
                    className="profile__ringtone-page-btn"
                    disabled={catalogLoading || catalogPage <= 1}
                    aria-label="Предыдущая страница"
                    onClick={() => void loadCatalog(catalogPage - 1)}
                  >
                    ‹
                  </button>
                  <span className="profile__ringtone-page-label">
                    {catalogLoading ? "…" : `${catalogPage} / ${catalogPages}`}
                  </span>
                  <button
                    type="button"
                    className="profile__ringtone-page-btn"
                    disabled={catalogLoading || catalogPage >= catalogPages}
                    aria-label="Следующая страница"
                    onClick={() => void loadCatalog(catalogPage + 1)}
                  >
                    ›
                  </button>
                </div>

                {catalogError && (
                  <p className="profile__ringtone-status is-error">
                    {catalogError}
                  </p>
                )}

                <div className="profile__ringtone-box">
                  <div
                    className={`profile__ringtone-row profile__ringtone-row--pinned ${!ringtone ? "is-selected" : ""}`}
                    role="option"
                    aria-selected={!ringtone}
                  >
                    <button
                      type="button"
                      className="profile__ringtone-select"
                      onClick={() => {
                        stopPreview();
                        setSavedRingtone(null);
                        setRingtone(null);
                      }}
                    >
                      <span className="profile__ringtone-check" aria-hidden>
                        {!ringtone ? "✓" : ""}
                      </span>
                      <span className="profile__ringtone-title">
                        Стандартный сигнал
                      </span>
                    </button>
                    <button
                      type="button"
                      className="profile__ringtone-preview"
                      aria-label="Прослушать стандартный"
                      onClick={() => {
                        stopPreview();
                        setPreviewId("default");
                        stopPreviewRef.current = previewRingtone(null);
                        window.setTimeout(() => setPreviewId(null), 400);
                      }}
                    >
                      <IconPlay size={12} />
                    </button>
                  </div>

                  {hasCustom ? (
                    <div
                      className={`profile__ringtone-row ${ringtone?.id === CUSTOM_RINGTONE_ID ? "is-selected" : ""}`}
                      role="option"
                      aria-selected={ringtone?.id === CUSTOM_RINGTONE_ID}
                    >
                      <button
                        type="button"
                        className="profile__ringtone-select"
                        onClick={() => {
                          const next: SavedRingtone = {
                            id: CUSTOM_RINGTONE_ID,
                            title: customTitle,
                            url: CUSTOM_RINGTONE_URL,
                            startSec: 0,
                          };
                          setSavedRingtone(next);
                          setRingtone(next);
                        }}
                      >
                        <span className="profile__ringtone-check" aria-hidden>
                          {ringtone?.id === CUSTOM_RINGTONE_ID ? "✓" : ""}
                        </span>
                        <span className="profile__ringtone-title">
                          {customTitle}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="profile__ringtone-preview"
                        aria-label={
                          previewId === CUSTOM_RINGTONE_ID
                            ? "Остановить"
                            : "Прослушать"
                        }
                        onClick={() => {
                          if (previewId === CUSTOM_RINGTONE_ID) {
                            stopPreview();
                            return;
                          }
                          void previewSaved({
                            id: CUSTOM_RINGTONE_ID,
                            title: customTitle,
                            url: CUSTOM_RINGTONE_URL,
                            startSec: 0,
                          });
                        }}
                      >
                        {previewId === CUSTOM_RINGTONE_ID ? (
                          <IconPause size={12} />
                        ) : (
                          <IconPlay size={12} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="profile__ringtone-preview profile__ringtone-preview--danger"
                        aria-label="Удалить свой рингтон"
                        onClick={() => {
                          stopPreview();
                          setConfirmDeleteCustom(true);
                        }}
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  ) : null}

                  <ul
                    className="profile__ringtone-list profile__ringtone-list--tab"
                    role="listbox"
                    aria-label="Список рингтонов"
                  >
                    {catalogLoading && catalog.length === 0 && (
                      <li>
                        <p className="profile__ringtone-status">Загрузка…</p>
                      </li>
                    )}

                    {!catalogError &&
                      catalog.length === 0 &&
                      !catalogLoading && (
                        <li>
                          <p className="profile__ringtone-status">Пусто</p>
                        </li>
                      )}

                    {catalog.map((item, index) => {
                      const selected = ringtone?.id === item.id;
                      const previewing = previewId === item.id;
                      return (
                        <li key={item.id || item.url || `tone-${index}`}>
                          <div
                            className={`profile__ringtone-row ${selected ? "is-selected" : ""}`}
                            role="option"
                            aria-selected={selected}
                          >
                            <button
                              type="button"
                              className="profile__ringtone-select"
                              title={item.title}
                              onClick={() => {
                                const next: SavedRingtone = {
                                  id: item.id,
                                  title: item.title,
                                  url: item.url,
                                  startSec: item.startSec || 0,
                                };
                                setSavedRingtone(next);
                                setRingtone(next);
                              }}
                            >
                              <span
                                className="profile__ringtone-check"
                                aria-hidden
                              >
                                {selected ? "✓" : ""}
                              </span>
                              <span className="profile__ringtone-title">
                                {item.title}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="profile__ringtone-preview"
                              aria-label={
                                previewing ? "Остановить" : "Прослушать"
                              }
                              onClick={() => {
                                if (previewing) {
                                  stopPreview();
                                  return;
                                }
                                stopPreview();
                                setPreviewId(item.id);
                                setCatalogError(null);
                                stopPreviewRef.current = previewRingtoneFrom(
                                  item.url,
                                  item.startSec || 0,
                                  () => {
                                    setPreviewId(null);
                                    setCatalogError(
                                      "Не удалось воспроизвести рингтон",
                                    );
                                  },
                                );
                              }}
                            >
                              {previewing ? (
                                <IconPause size={12} />
                              ) : (
                                <IconPlay size={12} />
                              )}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>
            ) : (
            <form className="profile__form" onSubmit={handleSubmit}>
              <div className="profile__avatar-wrap">
                <Avatar name={previewName} src={avatarUrl || null} size="lg" />
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
                  className={`profile__avatar-btn ${uploading || saving ? "is-disabled" : ""}`}
                  onClick={(event) => {
                    if (uploading || saving) event.preventDefault();
                  }}
                >
                  <IconCamera size={16} />
                  {uploading ? "Загрузка…" : "Фото"}
                </label>
                {avatarUrl && (
                  <button
                    type="button"
                    className="profile__clear"
                    disabled={saving}
                    onClick={() => setAvatarUrl("")}
                  >
                    Убрать фото
                  </button>
                )}
              </div>

              <label className="field">
                <span>Отображаемое имя</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={32}
                  required
                />
              </label>

              <label className="field">
                <span>Статус</span>
                <input
                  value={bio}
                  onChange={(event) => setBio(event.target.value)}
                  placeholder="Чем занимаетесь"
                  maxLength={120}
                />
              </label>

              <div className="profile__meta">
                <span>Логин</span>
                <strong>@{account.username}</strong>
                {connected && <em className="is-on">подключено</em>}
              </div>

              <label className="profile__toggle">
                <span>Звуки сообщений и звонков</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={soundOn}
                  className={`profile__switch ${soundOn ? "is-on" : ""}`}
                  onClick={() => {
                    const next = !soundOn;
                    setSoundOn(next);
                    setSoundEnabled(next);
                  }}
                >
                  <span className="profile__switch-knob" />
                </button>
              </label>

              <div className="profile__notify">
                <div>
                  <span>Уведомления браузера</span>
                  <em>
                    {notifyPerm === "granted"
                      ? "включены (сообщения и звонки)"
                      : notifyPerm === "denied"
                        ? "запрещены в браузере"
                        : notifyPerm === "default"
                          ? "не запрошены — нажмите «Разрешить»"
                          : "не поддерживаются"}
                  </em>
                  {(() => {
                    const hint = getNotifyCapabilityHint();
                    return hint ? (
                      <small className="profile__notify-hint">{hint}</small>
                    ) : null;
                  })()}
                </div>
                {notifyPerm === "default" && (
                  <button
                    type="button"
                    className="profile__notify-btn"
                    disabled={notifyBusy}
                    onClick={async () => {
                      setNotifyBusy(true);
                      try {
                        const next = await ensureNotifyPermission();
                        setNotifyPerm(next);
                        if (next === "granted") {
                          await subscribeWebPush(account.token);
                        }
                      } finally {
                        setNotifyBusy(false);
                      }
                    }}
                  >
                    {notifyBusy ? "Запрос…" : "Разрешить"}
                  </button>
                )}
              </div>

              {(localError || error) && (
                <p className="profile__error">{localError || error}</p>
              )}

              <div className="profile__actions">
                <button
                  type="submit"
                  className="profile__save"
                  disabled={saving || uploading}
                >
                  {saving ? "Сохранение…" : "Сохранить"}
                </button>
                <button
                  type="button"
                  className="profile__logout"
                  onClick={onLogout}
                >
                  <IconLogout size={16} />
                  Выйти
                </button>
              </div>
            </form>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
      <AvatarCropDialog
        open={Boolean(cropFile)}
        file={cropFile}
        onCancel={() => setCropFile(null)}
        onComplete={(file) => {
          void uploadCroppedAvatar(file);
        }}
      />
      <RingtoneTrimDialog
        open={Boolean(trimFile)}
        file={trimFile}
        initialStart={trimStart}
        initialEnd={trimEnd}
        onCancel={() => setTrimFile(null)}
        onComplete={(payload) => {
          void applyCustomRingtone(payload);
        }}
      />
      <ConfirmDialog
        open={confirmDeleteCustom}
        title="Удалить свой рингтон?"
        body="Файл пропадёт с этого устройства. Можно снова загрузить другой."
        confirmLabel="Удалить"
        onCancel={() => setConfirmDeleteCustom(false)}
        onConfirm={() => {
          void removeCustomRingtone();
        }}
      />
    </>
  );
}
