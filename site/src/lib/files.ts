import type { FileAttachment } from "@/lib/types";

export function bareMediaUrl(url: string) {
  return String(url || "").split("?")[0].split("#")[0];
}

/** Encode non-ASCII path segments so <img>/<video>/download links always resolve. */
export function isLocalMediaUrl(url?: string | null) {
  return String(url || "").startsWith("blob:");
}

export function mediaSrc(url: string) {
  if (isLocalMediaUrl(url)) return url;
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
  if (isLocalMediaUrl(url)) return url;
  const encoded = mediaSrc(url);
  if (!encoded) return "";
  const q = String(url || "").indexOf("?");
  if (q < 0) return encoded;
  return `${encoded}${String(url).slice(q)}`;
}

export function downloadHref(url: string) {
  if (isLocalMediaUrl(url)) return url;
  const encoded = mediaSrc(url);
  if (!encoded) return "#";
  const q = String(url || "").indexOf("?");
  const params = new URLSearchParams(q >= 0 ? String(url).slice(q + 1) : "");
  params.set("download", "1");
  return `${encoded}?${params.toString()}`;
}

/** Thumbnail URL for chat bubbles — server resizes JPEGs on the fly. */
export function thumbSrc(url: string, width = 430) {
  if (isLocalMediaUrl(url)) return url;
  const encoded = signedMediaSrc(url) || mediaSrc(url);
  if (!encoded) return "";
  return `${encoded}${encoded.includes("?") ? "&" : "?"}w=${width}`;
}

/** Drop `w=` so a failed thumbnail can fall back to the original file. */
export function withoutThumbParam(url: string) {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const path = url.slice(0, q);
  const params = new URLSearchParams(url.slice(q + 1));
  if (!params.has("w")) return url;
  params.delete("w");
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Human-readable attachment name without server uuid_ prefix. */
export function displayFileName(name?: string | null) {
  const raw = String(name || "").trim();
  if (!raw) return "Файл";
  return raw.replace(/^[0-9a-f-]{36}_/i, "") || "Файл";
}

export const MAX_FILE_BYTES = 500 * 1024 * 1024;
/** Media items in one album message (Telegram limit). */
export const MAX_FILES_AT_ONCE = 10;
/** Composer queue — extras go out as the next message(s). */
export const MAX_PENDING_FILES = 50;

export function chunkItems<T>(items: T[], size: number): T[][] {
  if (size < 1) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}
const UPLOAD_TIMEOUT_MS = 600_000;
const UPLOAD_RETRIES = 3;

export type UploadedFile = {
  url: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
};

/** tdesktop `st::maxGifSize` — GIFs sit in a 320 box, photos stay at 430. */
export const GIF_MAX_SIDE = 320;

/** Scale GIF into Telegram's max box; never upscale. */
export function fitGifDisplaySize(
  width: number,
  height: number,
  maxSide = GIF_MAX_SIDE,
) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, maxSide / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

/** Clamp client/server media pixel size for album layout. */
export function parseMediaSize(file?: {
  width?: unknown;
  height?: unknown;
} | null) {
  const width = Math.round(Number(file?.width));
  const height = Math.round(Number(file?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width < 1 || height < 1 || width > 16000 || height > 16000) {
    return undefined;
  }
  return { width, height };
}

type FileLike = {
  mime?: string | null;
  name?: string | null;
  url?: string | null;
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

export function isGifAttachment(file?: FileLike) {
  if (!file) return false;
  const mime = fileMime(file);
  const name = fileNameLower(file);
  const url = String(file.url || "");
  return (
    mime === "image/gif" ||
    /\.gif$/i.test(name) ||
    /^gif[-_.]/i.test(name) ||
    /giphy\.(gif|webp)$/i.test(name) ||
    /giphy\.com/i.test(url)
  );
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
  if (isImageAttachment(file)) {
    if (isGifAttachment(file)) return "GIF";
    return "Фото";
  }
  if (isVideoAttachment(file)) return "Видео";
  if (isVoiceNote(file)) return "Голосовое сообщение";
  if (isAudioAttachment(file)) return "Аудио";
  const name = String(file?.name || "").replace(/^[0-9a-f-]{36}_/i, "").trim();
  const fallback = String(fallbackText || "").trim();
  if (
    fallback === "Фото" ||
    fallback === "GIF" ||
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

const GENERIC_PREVIEW_LABELS = new Set([
  "фото",
  "gif",
  "видео",
  "аудио",
  "музыка",
  "медиафайл",
  "стикер",
  "голосовое сообщение",
  "файл",
]);

export function isGenericPreviewLabel(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (GENERIC_PREVIEW_LABELS.has(text.toLowerCase())) return true;
  if (/^\d+\s+(файл|файла|файлов)$/i.test(text)) return true;
  if (/^\d+\s+(фото|видео)$/i.test(text)) return true;
  if (/^(альбом|файлы)\s*·/i.test(text)) return true;
  if (/^музыка\s*·/i.test(text)) return true;
  if (/^файл:/i.test(text)) return true;
  return false;
}

export function ruFileCountLabel(count: number) {
  const n = Math.max(0, Math.floor(count));
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return `${n} файл`;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return `${n} файла`;
  return `${n} файлов`;
}

export function albumPreviewText(
  files: FileAttachment[],
  fallbackText?: string | null,
) {
  const caption = isGenericPreviewLabel(fallbackText)
    ? ""
    : String(fallbackText || "").trim();

  if (!files.length) return caption || "Файл";

  if (files.length === 1) {
    const file = files[0];
    if (isVoiceNote(file)) return "Голосовое сообщение";
    if (isAudioAttachment(file)) {
      const name = audioDisplayName(file);
      if (name && name !== "Аудио" && name !== "Голосовое сообщение") {
        return `Музыка · ${name}`;
      }
      return "Музыка";
    }
    if (isGifAttachment(file)) return caption || "GIF";
    if (isMediaAttachment(file)) return caption || "Медиафайл";
    return caption || attachmentPreviewText(file, fallbackText);
  }

  return caption || ruFileCountLabel(files.length);
}

export function chatListPreview(message: {
  kind?: string | null;
  text?: string | null;
  sticker?: { url?: string; animated?: boolean } | null;
  file?: FileAttachment | null;
  files?: FileAttachment[] | null;
}): { text: string; thumbUrl?: string; thumbAnimated?: boolean } {
  if (message.kind === "sticker" && message.sticker?.url) {
    return {
      text: String(message.text || "").trim() || "Стикер",
      thumbUrl: message.sticker.url,
      thumbAnimated: Boolean(message.sticker.animated),
    };
  }

  if (message.kind === "file") {
    const files = messageAttachments(message);
    const text = albumPreviewText(files, message.text);
    const first = files[0];
    if (files.length === 1 && first?.url && isGifAttachment(first)) {
      return { text, thumbUrl: first.url, thumbAnimated: true };
    }
    return { text };
  }

  return { text: String(message.text || "").trim() };
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

const DIRECT_PART_CONCURRENCY = 3;
const DIRECT_PART_RETRIES = 2;
const DIRECT_STALL_MS = 30_000;

/** S3 unreachable from this browser (CORS, blocked host) — use the server path. */
class DirectUploadUnavailable extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
  }
}

let directUploadDisabled = false;

type DirectUploadStart = {
  ok?: boolean;
  direct?: boolean;
  id?: string;
  parts?: Array<{ partNumber: number; size: number; url: string }>;
  error?: string;
};

function sanitizeDisplayName(file: File, fallback: string) {
  const name = String(file.name || fallback || "file")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .slice(0, 120);
  return name || fallback;
}

async function postUploadJson<T>(
  action: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; result: T | null }> {
  const response = await fetch(`/api/upload/direct/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pulse-token": token },
    body: JSON.stringify(body),
    signal,
  });
  let result: T | null = null;
  try {
    result = (await response.json()) as T;
  } catch {
    result = null;
  }
  return { status: response.status, result };
}

/** PUT one part to its pre-signed URL; resolves with the part ETag. */
function putDirectPart(
  url: string,
  blob: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Загрузка отменена"));
      return;
    }
    const xhr = new XMLHttpRequest();
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    // A blackholed S3 host would otherwise hang until UPLOAD_TIMEOUT_MS.
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, DIRECT_STALL_MS);
    };
    const onAbort = () => xhr.abort();
    const done = (error?: Error, etag?: string) => {
      clearTimeout(stallTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(etag || "");
    };
    xhr.open("PUT", url);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      armStallTimer();
      onProgress(event.loaded);
    };
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) {
        onProgress(blob.size);
        done(undefined, etag);
      } else {
        done(new DirectUploadUnavailable(`S3 part upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => done(new DirectUploadUnavailable("S3 unreachable"));
    xhr.ontimeout = () => done(new DirectUploadUnavailable("S3 timeout"));
    xhr.onabort = () =>
      done(stalled ? new DirectUploadUnavailable("S3 stalled", false) : new Error("Загрузка отменена"));
    signal?.addEventListener("abort", onAbort, { once: true });
    armStallTimer();
    xhr.send(blob);
  });
}

async function uploadFileDirect(
  file: File,
  token: string,
  options?: { onProgress?: (ratio: number) => void; signal?: AbortSignal },
): Promise<UploadedFile> {
  const signal = options?.signal;
  const start = await postUploadJson<DirectUploadStart>(
    "start",
    token,
    { name: file.name, size: file.size, type: file.type },
    signal,
  );
  const ticket = start.result;
  if (start.status === 404 && ticket?.direct === false) {
    throw new DirectUploadUnavailable("Direct upload is disabled");
  }
  if (!ticket?.ok || !ticket.id || !ticket.parts?.length) {
    throw new Error(
      ticket?.error ||
        (start.status === 413 ? "Файл слишком большой" : "Не удалось загрузить файл"),
    );
  }
  const id = ticket.id;
  const loaded = new Array<number>(ticket.parts.length).fill(0);
  const report = () =>
    options?.onProgress?.(
      Math.min(0.99, loaded.reduce((sum, value) => sum + value, 0) / file.size),
    );

  let offset = 0;
  const slices = ticket.parts.map((part) => {
    const blob = file.slice(offset, offset + part.size);
    offset += part.size;
    return { ...part, blob };
  });

  // One failed part stops the others before the server fallback re-sends the file.
  const partsAbort = new AbortController();
  const forwardAbort = () => partsAbort.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  let etags: string[];
  try {
    etags = await runPool(slices, DIRECT_PART_CONCURRENCY, async (part, index) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await putDirectPart(
            part.url,
            part.blob,
            (bytes) => {
              loaded[index] = bytes;
              report();
            },
            partsAbort.signal,
          );
        } catch (error) {
          loaded[index] = 0;
          if (
            isAbortError(error) ||
            (error instanceof DirectUploadUnavailable && !error.retryable) ||
            attempt >= DIRECT_PART_RETRIES
          ) {
            throw error;
          }
          await delay(400 * (attempt + 1));
        }
      }
    });
  } catch (error) {
    partsAbort.abort();
    void postUploadJson("abort", token, { id }).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }

  const complete = await postUploadJson<{ ok?: boolean; file?: UploadedFile; error?: string }>(
    "complete",
    token,
    { id, parts: etags.map((etag, index) => ({ partNumber: index + 1, etag })) },
    signal,
  );
  if (!complete.result?.ok || !complete.result.file) {
    throw new Error(complete.result?.error || "Не удалось загрузить файл");
  }
  options?.onProgress?.(1);
  return {
    ...complete.result.file,
    name: sanitizeDisplayName(file, complete.result.file.name),
  };
}

export async function uploadFile(
  file: File,
  token: string,
  options?: {
    kind?: "avatar" | "file";
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
  },
): Promise<UploadedFile> {
  if ((options?.kind || "file") === "file" && file.size > 0 && !directUploadDisabled) {
    try {
      return await uploadFileDirect(file, token, options);
    } catch (error) {
      if (!(error instanceof DirectUploadUnavailable)) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Загрузка отменена");
        }
        throw error;
      }
      directUploadDisabled = true;
      options?.onProgress?.(0);
    }
  }
  return uploadFileViaServer(file, token, options);
}

function uploadFileViaServer(
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


/** Sticker attachments (WebP/PNG static or WebM/VP9 animated). */
export function isStickerMedia(file?: {
  mime?: string | null;
  name?: string | null;
} | null): "animated" | "static" | null {
  if (!file) return null;
  const name = String(file.name || "").toLowerCase();
  const mime = String(file.mime || "").split(";")[0].trim().toLowerCase();
  if (mime === "video/webm" || /\.webm$/i.test(name)) return "animated";
  if (
    mime === "image/webp" ||
    mime === "image/png" ||
    /\.(webp|png)$/i.test(name)
  ) {
    return "static";
  }
  return null;
}

export const MAX_STICKER_BYTES = 6 * 1024 * 1024;