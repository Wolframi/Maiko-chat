import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import Busboy from "busboy";
import { isDevAccessibleHost } from "../lib/devHosts";
import { restoreSession } from "./auth";
import { rateLimit } from "./rateLimit";
import {
  isTranscodableVideoPath,
  normalizeVideoUploadPath,
  scheduleBrowserVideoTranscode,
} from "./videoTranscode";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  createReadStream,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const MAX_SIZE = 500 * 1024 * 1024;
const AVATAR_MAX_SIZE = 2 * 1024 * 1024;
const DEV = process.env.NODE_ENV !== "production";

const BLOCKED_EXT = new Set([
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
  ".phtml",
  ".asp",
  ".aspx",
  ".jsp",
  ".cgi",
  ".exe",
  ".bat",
  ".cmd",
  ".ps1",
  ".sh",
  ".wasm",
]);

const BLOCKED_MIME = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
]);

const AVATAR_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AVATAR_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const INLINE_IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".jfif",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
  ".heic",
  ".heif",
]);

const INLINE_MEDIA_EXT = new Set([
  ...INLINE_IMAGE_EXT,
  ".webm",
  ".weba",
  ".ogg",
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4",
  ".m4v",
  ".mov",
  ".aac",
  ".opus",
  ".flac",
]);

const OWNERS_FILE = path.join(process.cwd(), "data", "upload-owners.json");
const uploadOwners = new Map<string, string>(); // url -> userId

function loadOwners() {
  try {
    if (!existsSync(OWNERS_FILE)) return;
    const raw = JSON.parse(readFileSync(OWNERS_FILE, "utf8")) as Record<
      string,
      string
    >;
    for (const [url, userId] of Object.entries(raw)) {
      if (url.startsWith("/uploads/") && userId) {
        uploadOwners.set(url, userId);
      }
    }
  } catch {
    /* ignore */
  }
}

function saveOwners() {
  try {
    const dir = path.dirname(OWNERS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      OWNERS_FILE,
      JSON.stringify(Object.fromEntries(uploadOwners), null, 2),
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

function rememberUploadOwner(url: string, userId: string) {
  uploadOwners.set(bareUploadUrl(url), userId);
  saveOwners();
}

export function uploadOwnedBy(url: string, userId: string) {
  const owner = uploadOwners.get(bareUploadUrl(url));
  // Legacy files (before ownership tracking) stay sendable.
  if (!owner) return true;
  return owner === userId;
}

loadOwners();

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

const DATA_DIR = path.join(process.cwd(), "data");
const SECRET_FILE = path.join(DATA_DIR, "upload-secret.txt");
const SIGN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Avatars stay in UI for a long time; short TTL made them randomly 403. */
const AVATAR_SIGN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function signingSecret() {
  if (process.env.UPLOAD_SIGNING_SECRET) {
    return process.env.UPLOAD_SIGNING_SECRET;
  }
  try {
    if (existsSync(SECRET_FILE)) {
      return readFileSync(SECRET_FILE, "utf8").trim();
    }
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const secret = randomBytes(32).toString("hex");
    writeFileSync(SECRET_FILE, secret, "utf8");
    return secret;
  } catch {
    return "pulse-dev-upload-secret";
  }
}

export function bareUploadUrl(url: string) {
  return String(url || "").split("?")[0].split("#")[0];
}

function signPayload(bare: string, exp: number) {
  return createHmac("sha256", signingSecret())
    .update(`${bare}:${exp}`)
    .digest("hex");
}

export function signUploadUrl(url: string, ttlMs = SIGN_TTL_MS) {
  const bare = bareUploadUrl(url);
  if (!bare.startsWith("/uploads/")) return url;
  const exp = Date.now() + ttlMs;
  const sig = signPayload(bare, exp);
  return `${bare}?exp=${exp}&sig=${sig}`;
}

export function signAvatarUrl(url: string) {
  return signUploadUrl(url, AVATAR_SIGN_TTL_MS);
}

function verifyUploadSignature(bare: string, expRaw: string, sigRaw: string) {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = signPayload(bare, exp);
  const got = String(sigRaw || "");
  if (expected.length !== got.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch {
    return false;
  }
}

function safeName(name: string) {
  const cleaned = String(name || "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  const ext = path.extname(cleaned).slice(0, 12);
  const base = (ext ? cleaned.slice(0, -ext.length) : cleaned) || "file";
  const maxBase = Math.max(8, 80 - ext.length);
  return `${base.slice(0, maxBase)}${ext}` || `file${ext}`;
}

function ensureMediaExtension(fileName: string, mime: string) {
  const safe = safeName(fileName || "file");
  const ext = path.extname(safe).toLowerCase();
  const known = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".jfif",
    ".gif",
    ".webp",
    ".bmp",
    ".avif",
    ".heic",
    ".heif",
    ".mp4",
    ".webm",
    ".mov",
    ".m4v",
    ".mp3",
    ".wav",
    ".ogg",
    ".opus",
    ".m4a",
    ".aac",
    ".flac",
    ".weba",
    ".pdf",
    ".txt",
    ".zip",
  ]);
  if (known.has(ext)) return safe;
  const normalized = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/pjpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/x-ms-bmp": ".bmp",
    "image/avif": ".avif",
    "image/heic": ".heic",
    "image/heif": ".heif",
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
  const add = map[normalized];
  if (!add) return safe;
  const base = safe.replace(/\.[^.]+$/, "") || "file";
  return `${base}${add}`;
}

export function mimeFromName(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jfif": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".weba": "audio/webm",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

const AUDIO_EXT = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".opus",
  ".m4a",
  ".aac",
  ".flac",
  ".weba",
]);

function resolveUploadMime(fileName: string, rawMime: string) {
  const ext = path.extname(fileName).toLowerCase();
  const mime = String(rawMime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const voiceName = /^voice[-_]/i.test(fileName);

  if (mime.startsWith("audio/") || voiceName) {
    if (mime.startsWith("audio/")) return mime;
    if (ext === ".m4a" || ext === ".aac") return "audio/mp4";
    if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
    if (ext === ".mp3") return "audio/mpeg";
    if (ext === ".wav") return "audio/wav";
    return "audio/webm";
  }

  // Uploaded audio files (not video) — force audio/* even if browser lied.
  if (AUDIO_EXT.has(ext)) {
    return mimeFromName(fileName);
  }
  // Voice notes often arrive as .webm with empty/octet mime.
  if (
    ext === ".webm" &&
    voiceName &&
    (!mime || mime === "application/octet-stream" || mime.startsWith("audio/"))
  ) {
    return "audio/webm";
  }
  if (ext === ".webm" && mime.startsWith("video/")) return "video/webm";
  if (ext === ".webm" && mime.startsWith("audio/")) return mime;

  return mime || mimeFromName(fileName);
}

export function isBlockedUpload(fileName: string, mime?: string) {
  const ext = path.extname(fileName).toLowerCase();
  if (BLOCKED_EXT.has(ext)) return true;
  const normalized = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (normalized && BLOCKED_MIME.has(normalized)) return true;
  if (normalized.startsWith("image/svg")) return true;
  return false;
}

function isAllowedAvatar(fileName: string, mime: string) {
  const ext = path.extname(fileName).toLowerCase();
  const normalized = mime.split(";")[0].trim().toLowerCase();
  const looseMime =
    !normalized ||
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream";
  if (AVATAR_EXT.has(ext)) {
    if (looseMime) return true;
    if (AVATAR_MIME.has(normalized)) return true;
    if (normalized === "image/jpg" || normalized === "image/pjpeg") return true;
    if (normalized.startsWith("image/") && !normalized.includes("svg")) {
      return true;
    }
  }
  // Phone cameras sometimes omit extension — trust image/* + magic bytes later
  if (
    (normalized === "image/jpeg" ||
      normalized === "image/jpg" ||
      normalized === "image/png" ||
      normalized === "image/webp" ||
      normalized === "image/gif" ||
      normalized === "image/pjpeg") &&
    !normalized.includes("svg")
  ) {
    return true;
  }
  return false;
}

function avatarStoredName(fileName: string, mime: string) {
  const safe = safeName(fileName || "avatar");
  const ext = path.extname(safe).toLowerCase();
  if (AVATAR_EXT.has(ext)) return safe;
  const normalized = mime.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/pjpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  const add = map[normalized] || ".jpg";
  const base = safe.replace(/\.[^.]+$/, "") || "avatar";
  return `${base}${add}`;
}

function isLoopbackHost(hostHeader: string) {
  const host = hostHeader.split(",")[0].trim().split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function hostFromUrlLike(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function originMatchesRequestHost(
  originHost: string,
  host: string,
  forwardedHost: string,
) {
  if (!originHost) return false;
  if (host && originHost === host) return true;
  if (forwardedHost && originHost === forwardedHost) return true;
  if (host && originHost.split(":")[0] === host.split(":")[0]) return true;
  if (
    forwardedHost &&
    originHost.split(":")[0] === forwardedHost.split(":")[0]
  ) {
    return true;
  }
  return false;
}

function isAllowedUploadOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  const referer = String(req.headers.referer || "");
  const host = String(req.headers.host || "");
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const publicOrigin = (process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "");

  if (!origin) {
    // Same-origin XHR usually sends Origin; allow same-site fetch without it.
    if (site === "same-origin" || site === "same-site" || site === "none") {
      return true;
    }
    // Some proxies strip Origin — fall back to Referer / PUBLIC_ORIGIN.
    const refererHost = hostFromUrlLike(referer);
    if (originMatchesRequestHost(refererHost, host, forwardedHost)) {
      return true;
    }
    if (publicOrigin && referer.replace(/\/$/, "").startsWith(publicOrigin)) {
      return true;
    }
    return DEV;
  }

  try {
    const parsed = new URL(origin);
    if (originMatchesRequestHost(parsed.host, host, forwardedHost)) {
      return true;
    }

    if (publicOrigin && origin.replace(/\/$/, "") === publicOrigin) return true;

    // Cloudflare/local tunnel: browser Origin is public, Host is 127.0.0.1
    if (
      process.env.TRUST_PROXY === "1" &&
      host &&
      isLoopbackHost(host) &&
      (parsed.protocol === "https:" || parsed.protocol === "http:")
    ) {
      return true;
    }

    if (
      DEV &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        isDevAccessibleHost(parsed.hostname))
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function looksLikeImage(filePath: string) {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    closeSync(fd);
    if (n < 3) return false;
    // JPEG / JFIF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
    // PNG
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return true;
    }
    // GIF
    if (buf.slice(0, 4).toString("ascii") === "GIF8") return true;
    // BMP
    if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
    // WEBP (RIFF....WEBP)
    if (
      n >= 12 &&
      buf.slice(0, 4).toString("ascii") === "RIFF" &&
      buf.slice(8, 12).toString("ascii") === "WEBP"
    ) {
      return true;
    }
    // AVIF / HEIC / HEIF (ISO BMFF ftyp) — major or compatible brands
    if (n >= 12 && buf.slice(4, 8).toString("ascii") === "ftyp") {
      try {
        const fd2 = openSync(filePath, "r");
        const big = Buffer.alloc(64);
        const m = readSync(fd2, big, 0, 64, 0);
        closeSync(fd2);
        const ascii = big.slice(0, m).toString("latin1").toLowerCase();
        if (
          /avif|avis|heic|heif|heix|heim|heis|hevc|hevx|mif1|msf1/.test(ascii)
        ) {
          return true;
        }
      } catch {
        const brand = buf.slice(8, 12).toString("ascii").toLowerCase();
        if (
          /^(avif|avis|heic|heif|heix|heim|heis|hevc|hevx|mif1|msf1)/.test(
            brand,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** True if url points at an existing avatar-safe upload on disk. */
export function isValidStoredAvatar(url: string) {
  const bare = bareUploadUrl(url);
  if (
    !/^\/uploads\/[0-9a-f-]{36}(?:_[^/\\]+)?\.(png|jpe?g|gif|webp)$/i.test(
      bare,
    ) ||
    bare.includes("..")
  ) {
    return false;
  }
  const full = uploadPathFromUrl(bare);
  if (!full) return false;
  return looksLikeImage(full);
}

function cleanupPath(filePath: string | null) {
  if (!filePath) return;
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

export function uploadPathFromUrl(url: string) {
  const bare = bareUploadUrl(url);
  if (!bare.startsWith("/uploads/")) return null;
  const fileName = path.basename(bare);
  if (!fileName || fileName !== bare.slice("/uploads/".length)) return null;
  const full = path.join(UPLOAD_DIR, fileName);
  if (!existsSync(full)) return null;
  return full;
}

const STREAM_CHUNK = 256 * 1024;

function pipeUpload(
  filePath: string,
  res: ServerResponse,
  range?: { start: number; end: number },
) {
  const stream = createReadStream(filePath, {
    ...range,
    highWaterMark: STREAM_CHUNK,
  });
  stream.on("error", () => {
    if (!res.writableEnded) res.destroy();
  });
  stream.pipe(res);
}

export function tryServeUpload(req: IncomingMessage, res: ServerResponse) {
  const url = req.url || "";
  if (!url.startsWith("/uploads/")) return false;

  const parsed = new URL(url, "http://localhost");
  const fileName = decodeURIComponent(path.basename(parsed.pathname));
  const bare = `/uploads/${fileName}`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  if (!fileName || !existsSync(filePath)) {
    res.statusCode = 404;
    res.end("Not found");
    return true;
  }

  const download = parsed.searchParams.has("download");
  // Legacy: uuid_OriginalName.ext · new: uuid.ext
  const stripped = fileName.replace(/^[0-9a-f-]{36}_?/i, "");
  const original =
    stripped && stripped !== fileName && path.extname(stripped)
      ? stripped
      : fileName;
  const ext = path.extname(fileName).toLowerCase() || path.extname(original).toLowerCase();
  const looksImage = looksLikeImage(filePath);
  const isInlineVisual =
    INLINE_MEDIA_EXT.has(ext) ||
    looksImage ||
    ext === ".mov" ||
    ext === ".m4v" ||
    ext === ".mkv" ||
    ext === ".avi";
  const exp = parsed.searchParams.get("exp") || "";
  const sig = parsed.searchParams.get("sig") || "";
  // Photos/videos/avatars: UUID path is the capability — allow missing/expired
  // signatures so cached message media doesn't randomly 403.
  if (!isInlineVisual) {
    if (!verifyUploadSignature(bare, exp, sig)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return true;
    }
  }

  const stat = statSync(filePath);
  const size = stat.size;
  const isVoiceName = /^voice[-_]/i.test(original);
  let mime = mimeFromName(fileName);
  if (looksImage && !mime.startsWith("image/")) {
    mime = "image/jpeg";
  }
  // MediaRecorder voice notes are audio even when stored as .webm.
  if (isVoiceName && (ext === ".webm" || ext === ".weba" || ext === ".ogg" || ext === ".m4a")) {
    mime =
      ext === ".m4a"
        ? "audio/mp4"
        : ext === ".ogg"
          ? "audio/ogg"
          : "audio/webm";
  }
  // Prefer video/* for real video containers even if client/server mime drifted.
  if (
    (ext === ".mp4" || ext === ".m4v" || ext === ".mov") &&
    !mime.startsWith("video/")
  ) {
    mime = ext === ".mov" ? "video/quicktime" : "video/mp4";
  }
  if (ext === ".webm" && !isVoiceName && !mime.startsWith("audio/")) {
    mime = "video/webm";
  }

  const forceAttach = download || !INLINE_MEDIA_EXT.has(ext);
  const disposition = `${forceAttach ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(original)}`;
  const isVideo = mime.startsWith("video/");
  // Videos are often replaced after HEVC→H.264 — short cache + ETag so PC
  // browsers pick up the converted file instead of a stale audio-only copy.
  const etag = `"${size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  const cacheControl = isVideo
    ? "private, max-age=60, must-revalidate"
    : "public, max-age=31536000, immutable";

  const baseHeaders: Record<string, string | number> = {
    "Content-Type": mime,
    "Cache-Control": cacheControl,
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Content-Disposition": disposition,
  };

  const ifNoneMatch = String(req.headers["if-none-match"] || "");
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.writeHead(304, {
      ETag: etag,
      "Cache-Control": cacheControl,
      "Accept-Ranges": "bytes",
    });
    res.end();
    return true;
  }

  if (req.method === "HEAD") {
    res.writeHead(200, { ...baseHeaders, "Content-Length": size });
    res.end();
    return true;
  }

  // Chrome (desktop) needs real 206 responses for MP4 — advertising Accept-Ranges
  // without partial content makes video play as audio-only / fail to seek.
  const rangeHeader = String(req.headers.range || "");
  const rangeMatch = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
  if (rangeMatch) {
    let start = rangeMatch[1] ? Number(rangeMatch[1]) : NaN;
    let end = rangeMatch[2] ? Number(rangeMatch[2]) : NaN;
    if (Number.isNaN(start)) {
      // suffix: bytes=-N
      const suffix = Number.isNaN(end) ? 0 : end;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      if (Number.isNaN(end) || end >= size) end = size - 1;
    }
    if (start >= size || start < 0 || end < start) {
      res.writeHead(416, {
        "Content-Range": `bytes */${size}`,
        "Accept-Ranges": "bytes",
      });
      res.end();
      return true;
    }
    // Cap oversized first-chunk requests (common from video elements).
    if (end - start + 1 > 8 * 1024 * 1024 && start === 0) {
      end = Math.min(size - 1, start + 2 * 1024 * 1024 - 1);
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": chunkSize,
    });
    pipeUpload(filePath, res, { start, end });
    return true;
  }

  res.writeHead(200, { ...baseHeaders, "Content-Length": size });
  pipeUpload(filePath, res);
  return true;
}

export function handleUpload(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  if (!isAllowedUploadOrigin(req)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Запрещённый Origin" }));
    return;
  }

  const parsed = new URL(req.url || "", "http://localhost");
  const kind = parsed.searchParams.get("kind");
  const isAvatar = kind === "avatar";
  const maxSize = isAvatar ? AVATAR_MAX_SIZE : MAX_SIZE;

  // Header-only auth — never accept ?token= (leaks via Referer/logs)
  const token = String(req.headers["x-pulse-token"] || "");
  const session = restoreSession(token);
  if (!session.ok) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Нужен вход" }));
    return;
  }

  const clientKey =
    String(req.socket.remoteAddress || "unknown") +
    ":" +
    session.account.userId;
  if (!rateLimit(`upload:${clientKey}`, 30, 60_000)) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Слишком много загрузок" }));
    return;
  }

  let busboy: ReturnType<typeof Busboy>;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: maxSize, files: 1 },
    });
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Неверный запрос загрузки" }));
    return;
  }

  let saved:
    | {
        url: string;
        name: string;
        size: number;
        mime: string;
      }
    | null = null;
  let storedPath: string | null = null;
  let writeStream: ReturnType<typeof createWriteStream> | null = null;
  let tooLarge = false;
  let writeError: Error | null = null;
  let invalidType = false;
  let badMagic = false;
  let responded = false;
  let clientAborted = false;
  let originalNameField = "";
  let writeDone: Promise<void> = Promise.resolve();

  function respond(status: number, body: Record<string, unknown>) {
    if (responded || res.writableEnded) return;
    responded = true;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(JSON.stringify(body));
  }

  const onAbort = () => {
    clientAborted = true;
    writeError = new Error("Загрузка прервана");
    try {
      writeStream?.destroy();
    } catch {
      /* ignore */
    }
    cleanupPath(storedPath);
    storedPath = null;
    saved = null;
  };

  req.on("aborted", onAbort);

  busboy.on("field", (name, value) => {
    if (name === "originalName") {
      originalNameField = String(value || "")
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .slice(0, 120);
    }
  });

  busboy.on("file", (_name, file, info) => {
    const mime = info.mimeType || "application/octet-stream";
    const sourceName = originalNameField || info.filename || "file";
    const original = isAvatar
      ? avatarStoredName(sourceName || "avatar.png", mime)
      : ensureMediaExtension(sourceName || "file", mime);

    if (isAvatar) {
      if (!isAllowedAvatar(original, mime)) {
        invalidType = true;
        file.resume();
        return;
      }
    } else if (isBlockedUpload(original, mime)) {
      invalidType = true;
      file.resume();
      return;
    }

    const id = randomUUID();
    // ASCII-only on-disk name — Cyrillic in URLs breaks some proxies/browsers.
    const storedExt =
      path.extname(original).toLowerCase() ||
      path.extname(ensureMediaExtension("file", mime)).toLowerCase() ||
      ".bin";
    const stored = `${id}${storedExt}`;
    const full = path.join(UPLOAD_DIR, stored);
    storedPath = full;
    const out = createWriteStream(full);
    writeStream = out;
    let size = 0;

    writeDone = new Promise<void>((resolve) => {
      file.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });

      file.on("limit", () => {
        tooLarge = true;
        out.destroy();
      });

      out.on("error", (error) => {
        writeError = error;
        cleanupPath(full);
        resolve();
      });

      out.on("close", () => {
        void (async () => {
          if (tooLarge || writeError || clientAborted || req.aborted) {
            cleanupPath(full);
            resolve();
            return;
          }
          if (
            (isAvatar ||
              INLINE_IMAGE_EXT.has(path.extname(original).toLowerCase())) &&
            !looksLikeImage(full)
          ) {
            badMagic = true;
            cleanupPath(full);
            resolve();
            return;
          }
          const rawMime = mime.split(";")[0].trim().toLowerCase();
          let savedMime = resolveUploadMime(original, rawMime);
          let finalPath = full;
          let finalStored = stored;
          const finalSize = size;

          // Respond immediately; HEVC→H.264 runs in background and replaces the file.
          if (!isAvatar && isTranscodableVideoPath(full, savedMime)) {
            try {
              const normalized = normalizeVideoUploadPath(full, savedMime);
              finalPath = normalized.path;
              finalStored = path.basename(normalized.path);
              savedMime = normalized.mime || savedMime;
              storedPath = finalPath;
              scheduleBrowserVideoTranscode(finalPath, savedMime);
            } catch (error) {
              console.warn("[upload] video normalize skipped", error);
            }
          }

          const displaySource = originalNameField || original;
          saved = {
            url: `/uploads/${finalStored}`,
            name: ensureMediaExtension(displaySource, savedMime),
            size: finalSize,
            mime: savedMime,
          };
          resolve();
        })();
      });

      file.on("error", (error) => {
        writeError = error;
        out.destroy();
        cleanupPath(full);
        resolve();
      });

      file.pipe(out);
    });
  });

  busboy.on("error", () => {
    cleanupPath(storedPath);
    respond(400, { ok: false, error: "Ошибка загрузки" });
  });

  busboy.on("finish", () => {
    void writeDone.then(() => {
      if (saved && originalNameField) {
        saved = {
          ...saved,
          name: ensureMediaExtension(originalNameField, saved.mime),
        };
      }
      if (invalidType) {
        cleanupPath(storedPath);
        respond(400, {
          ok: false,
          error: isAvatar
            ? "Нужно изображение PNG, JPEG, GIF или WebP"
            : "Этот тип файла запрещён",
        });
        return;
      }
      if (badMagic) {
        cleanupPath(storedPath);
        respond(400, { ok: false, error: "Файл не похож на изображение" });
        return;
      }
      if (tooLarge) {
        cleanupPath(storedPath);
        respond(413, {
          ok: false,
          error: isAvatar ? "Аватар больше 2 МБ" : "Файл больше 500 МБ",
        });
        return;
      }
      if (clientAborted || writeError || !saved) {
        cleanupPath(storedPath);
        respond(400, { ok: false, error: "Не удалось сохранить файл" });
        return;
      }
      rememberUploadOwner(saved.url, session.account.userId);
      respond(200, {
        ok: true,
        file: { ...saved, url: signUploadUrl(saved.url) },
      });
    });
  });

  req.pipe(busboy);
}
