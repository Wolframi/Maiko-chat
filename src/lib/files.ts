import type { FileAttachment } from "@/lib/types";

export function bareMediaUrl(url: string) {
  return String(url || "").split("?")[0].split("#")[0];
}

/** Encode non-ASCII path segments so <img>/<video>/download links always resolve. */
export function mediaSrc(url: string) {
  const bare = bareMediaUrl(url);
  if (!bare) return "";
  const q = bare.lastIndexOf("/");
  const dir = q >= 0 ? bare.slice(0, q + 1) : "";
  const name = q >= 0 ? bare.slice(q + 1) : bare;
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  return `${dir}${encodeURIComponent(decoded)}`;
}

/** Keep ?exp&sig (and other query) while encoding the path for Cyrillic names. */
export function signedMediaSrc(url: string) {
  const encoded = mediaSrc(url);
  if (!encoded) return "";
  const q = String(url || "").indexOf("?");
  if (q < 0) return encoded;
  return `${encoded}${String(url).slice(q)}`;
}

export function downloadHref(url: string) {
  const encoded = mediaSrc(url);
  if (!encoded) return "#";
  const q = String(url || "").indexOf("?");
  const params = new URLSearchParams(q >= 0 ? String(url).slice(q + 1) : "");
  params.set("download", "1");
  return `${encoded}?${params.toString()}`;
}

/** Human-readable attachment name without server uuid_ prefix. */
export function displayFileName(name?: string | null) {
  const raw = String(name || "").trim();
  if (!raw) return "Файл";
  return raw.replace(/^[0-9a-f-]{36}_/i, "") || "Файл";
}

export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_FILES_AT_ONCE = 10;
const UPLOAD_TIMEOUT_MS = 600_000;
const UPLOAD_RETRIES = 3;

export type UploadedFile = {
  url: string;
  name: string;
  size: number;
  mime: string;
};

type FileLike = {
  mime?: string | null;
  name?: string | null;
} | null | undefined;

function fileMime(file?: FileLike) {
  return String(file?.mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function fileNameLower(file?: FileLike) {
  return String(file?.name || "").toLowerCase();
}

/** Voice notes and uploaded audio — rendered as waveform player, not a file card. */
export function isAudioAttachment(file?: FileLike) {
  if (!file) return false;
  const mime = fileMime(file);
  const name = fileNameLower(file);
  // Real video containers must never be treated as voice notes.
  if (/\.(mp4|m4v|mov)$/i.test(name) || mime.startsWith("video/")) return false;
  if (mime.startsWith("audio/")) return true;
  if (/^voice[-_]/.test(name)) return true;
  if (/\.(mp3|wav|m4a|aac|ogg|opus|flac|weba)$/i.test(name)) return true;
  return false;
}

/** Image attachments — framed media block, no filename caption. */
export function isImageAttachment(file?: FileLike) {
  if (!file) return false;
  const name = fileNameLower(file);
  // Browsers do not support HEIC/HEIF natively, treat as regular file download
  if (/\.(heic|heif)$/i.test(name)) return false;
  const mime = fileMime(file);
  if (mime.startsWith("image/") && !mime.includes("svg") && !mime.includes("heic") && !mime.includes("heif")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

/** Video attachments — media block, no filename caption / copy. */
export function isVideoAttachment(file?: FileLike) {
  if (!file || isAudioAttachment(file)) return false;
  const name = fileNameLower(file);
  // Browsers do not support MKV/AVI natively, treat as regular file download
  if (/\.(mkv|avi)$/i.test(name)) return false;
  const mime = fileMime(file);
  if (mime.startsWith("video/") && !mime.includes("mkv") && !mime.includes("avi")) return true;
  return /\.(mp4|webm|mov|m4v)$/i.test(name);
}

export function isMediaAttachment(file?: FileLike) {
  return isImageAttachment(file) || isVideoAttachment(file);
}

/** Short label for chat list / notifications — never raw voice filenames. */
export function attachmentPreviewText(
  file?: FileLike,
  fallbackText?: string | null,
) {
  if (isImageAttachment(file)) return "Фото";
  if (isVideoAttachment(file)) return "Видео";
  if (isVoiceNote(file)) return "Голосовое сообщение";
  if (isAudioAttachment(file)) return "Аудио";
  const name = String(file?.name || "").replace(/^[0-9a-f-]{36}_/i, "").trim();
  const fallback = String(fallbackText || "").trim();
  if (
    fallback === "Фото" ||
    fallback === "Видео" ||
    fallback === "Аудио" ||
    fallback === "Голосовое сообщение"
  ) {
    return fallback;
  }
  if (name) return `Файл: ${name}`;
  return fallback || "Файл";
}

/** Attachments on a message (album or single file). */
export function messageAttachments(message: {
  file?: FileAttachment | null;
  files?: FileAttachment[] | null;
}): FileAttachment[] {
  if (Array.isArray(message.files) && message.files.length > 0) {
    return message.files.filter((item) => Boolean(item?.url));
  }
  if (message.file?.url) return [message.file];
  return [];
}

export function albumPreviewText(
  files: FileAttachment[],
  fallbackText?: string | null,
) {
  if (!files.length) return String(fallbackText || "").trim() || "Файл";
  if (files.length === 1) return attachmentPreviewText(files[0], fallbackText);
  const images = files.filter((f) => isImageAttachment(f)).length;
  const videos = files.filter((f) => isVideoAttachment(f)).length;
  if (images && !videos) return `${files.length} фото`;
  if (videos && !images) return `${files.length} видео`;
  if (images || videos) return `Альбом · ${files.length}`;
  return `Файлы · ${files.length}`;
}

/** Recorded in-app voice note (not a file the user picked). */
export function isVoiceNote(file?: {
  mime?: string | null;
  name?: string | null;
} | null) {
  return /^voice[-_]/i.test(String(file?.name || ""));
}

export function audioDisplayName(file?: {
  mime?: string | null;
  name?: string | null;
} | null) {
  const raw = String(file?.name || "").trim();
  if (!raw) return "Аудио";
  if (/^voice[-_]/i.test(raw)) return "Голосовое сообщение";
  // Strip uuid_ prefix if server stored as id_original
  const cleaned = raw.replace(/^[0-9a-f-]{36}_/i, "");
  return cleaned || "Аудио";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function validateAvatarFile(file: File) {
  if (!file || !file.size) return "Пустой файл";
  if (file.size > 2 * 1024 * 1024) return "Аватар больше 2 МБ";
  const name = file.name || "";
  const ext = name.includes(".")
    ? `.${name.split(".").pop()!.toLowerCase()}`
    : "";
  const mime = (file.type || "").toLowerCase();
  const okExt = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
  const okMime =
    !mime ||
    mime === "application/octet-stream" ||
    mime.startsWith("image/jpeg") ||
    mime === "image/jpg" ||
    mime === "image/png" ||
    mime === "image/gif" ||
    mime === "image/webp" ||
    mime === "image/pjpeg";
  if (mime.includes("svg")) return "SVG для аватара нельзя";
  if (!okExt && !okMime) {
    return "Нужно изображение PNG, JPEG, GIF или WebP";
  }
  return null;
}

export function validateFile(file: File) {
  if (!file || !file.size) return "Пустой файл";
  if (file.size > MAX_FILE_BYTES) {
    return `Файл больше ${formatBytes(MAX_FILE_BYTES)}`;
  }
  const name = file.name || "";
  const ext = name.includes(".")
    ? `.${name.split(".").pop()!.toLowerCase()}`
    : "";
  const blocked = new Set([
    ".svg",
    ".svgz",
    ".html",
    ".htm",
    ".xhtml",
    ".xml",
    ".js",
    ".mjs",
    ".cjs",
    ".php",
    ".exe",
    ".bat",
    ".cmd",
    ".ps1",
    ".sh",
  ]);
  if (blocked.has(ext)) return "Этот тип файла запрещён";
  const mime = (file.type || "").toLowerCase();
  if (
    mime.includes("svg") ||
    mime === "text/html" ||
    mime === "application/javascript" ||
    mime === "text/javascript"
  ) {
    return "Этот тип файла запрещён";
  }
  return null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.message === "Загрузка отменена";
}

/** ASCII filename for multipart — Cyrillic in Content-Disposition breaks uploads. */
export function uploadPartFileName(file: File) {
  const raw = String(file.name || "file");
  const fromName = raw.includes(".")
    ? `.${raw.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "")}`
    : "";
  const mime = (file.type || "").toLowerCase();
  const byMime: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/pjpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/webm": ".weba",
  };
  const known = new Set([
    ...Object.values(byMime),
    ".jpeg",
    ".heic",
    ".heif",
  ]);
  const ext = known.has(fromName)
    ? fromName === ".jpeg"
      ? ".jpg"
      : fromName
    : byMime[mime] || ".bin";
  return `upload${ext}`;
}

export function uploadFile(
  file: File,
  token: string,
  options?: {
    kind?: "avatar" | "file";
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
  },
): Promise<UploadedFile> {
  const kind = options?.kind || "file";
  const url =
    kind === "avatar" ? "/api/upload?kind=avatar" : "/api/upload";

  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error("Загрузка отменена"));
      return;
    }

    const xhr = new XMLHttpRequest();
    let settled = false;

    function finish(error?: Error, value?: UploadedFile) {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (value) resolve(value);
    }

    function onAbort() {
      xhr.abort();
    }

    xhr.open("POST", url);
    xhr.setRequestHeader("x-pulse-token", token);
    xhr.timeout = UPLOAD_TIMEOUT_MS;

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      options?.onProgress?.(event.loaded / event.total);
    };

    xhr.onload = () => {
      let result: {
        ok?: boolean;
        file?: UploadedFile;
        error?: string;
      } | null = null;

      try {
        result = JSON.parse(String(xhr.responseText || "")) as {
          ok?: boolean;
          file?: UploadedFile;
          error?: string;
        };
      } catch {
        result = null;
      }

      if (xhr.status >= 200 && xhr.status < 300 && result?.ok && result.file) {
        options?.onProgress?.(1);
        const displayName = String(file.name || result.file.name || "file")
          .replace(/[\u0000-\u001F\u007F]/g, "")
          .slice(0, 120);
        finish(undefined, {
          ...result.file,
          name: displayName || result.file.name,
        });
        return;
      }

      finish(
        new Error(
          result?.error ||
            (xhr.status === 403
              ? "Загрузка запрещена (Origin)"
              : xhr.status === 413
                ? "Файл слишком большой"
                : "Не удалось загрузить файл"),
        ),
      );
    };

    xhr.onerror = () => finish(new Error("Сеть недоступна"));
    xhr.ontimeout = () => finish(new Error("Превышено время загрузки"));
    xhr.onabort = () => finish(new Error("Загрузка отменена"));

    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const body = new FormData();
    if (file.name) body.append("originalName", file.name.slice(0, 120));
    const partName =
      kind === "avatar" ? "avatar.jpg" : uploadPartFileName(file);
    body.append("file", file, partName);
    xhr.send(body);
  });
}

export async function uploadFileWithRetry(
  file: File,
  token: string,
  options?: {
    kind?: "avatar" | "file";
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
    retries?: number;
  },
): Promise<UploadedFile> {
  const retries = options?.retries ?? UPLOAD_RETRIES;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options?.signal?.aborted) {
      throw new Error("Загрузка отменена");
    }

    try {
      return await uploadFile(file, token, {
        kind: options?.kind,
        onProgress: options?.onProgress,
        signal: options?.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError =
        error instanceof Error ? error : new Error("Не удалось загрузить файл");
      if (attempt < retries) {
        await delay(350 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error("Не удалось загрузить файл");
}

/** Run async work over items with a concurrency cap. */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.min(Math.max(1, limit), items.length);
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
