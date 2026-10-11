import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import Busboy from "busboy";
import { pipeline } from "node:stream/promises";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  downloadObjectToTemp,
  headObject,
  isObjectNotFound,
  presignUploadPart,
  putObjectFile,
  readObject,
  readObjectPrefix,
  s3Enabled,
  withObjectFile,
} from "./objectStorage";
import { isDevAccessibleHost } from "../lib/devHosts";
import { restoreSession } from "./auth";
import { rateLimit } from "./rateLimit";
import { audioWaveform } from "./audioWaveform";
import {
  isTranscodableVideoPath,
  normalizedVideoName,
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
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const THUMB_DIR = path.join(UPLOAD_DIR, "thumbs");
const THUMB_WIDTHS = new Set(["320", "430", "860", "1080"]);
const THUMB_SOURCE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
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
if (!existsSync(THUMB_DIR)) {
  mkdirSync(THUMB_DIR, { recursive: true });
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

const IMAGE_SNIFF_BYTES = 64;

export function looksLikeImage(filePath: string) {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(IMAGE_SNIFF_BYTES);
    const n = readSync(fd, buf, 0, IMAGE_SNIFF_BYTES, 0);
    closeSync(fd);
    return looksLikeImageBytes(buf.subarray(0, n));
  } catch {
    return false;
  }
}

/** `buf` is the first IMAGE_SNIFF_BYTES of the file (or the whole file if shorter). */
export function looksLikeImageBytes(buf: Buffer) {
  const n = buf.length;
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
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return true;
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // WEBP (RIFF....WEBP)
  if (
    n >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return true;
  }
  // AVIF / HEIC / HEIF (ISO BMFF ftyp) — major or compatible brands
  if (n >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const ascii = buf.subarray(0, IMAGE_SNIFF_BYTES).toString("latin1").toLowerCase();
    return /avif|avis|heic|heif|heix|heim|heis|hevc|hevx|mif1|msf1/.test(ascii);
  }
  return false;
}

/** Validate the actual image bytes, including after migration to S3. */
export async function isValidStoredAvatar(url: string) {
  const bare = bareUploadUrl(url);
  if (
    !/^\/uploads\/[0-9a-f-]{36}(?:_[^/\\]+)?\.(png|jpe?g|gif|webp)$/i.test(
      bare,
    ) ||
    bare.includes("..")
  ) {
    return false;
  }
  try {
    return await withUploadFile(bare, looksLikeImage);
  } catch {
    return false;
  }
}

function cleanupPath(filePath: string | null) {
  if (!filePath) return;
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

export function uploadNameFromUrl(url: string) {
  const bare = bareUploadUrl(url);
  if (!bare.startsWith("/uploads/")) return null;
  try {
    const fileName = decodeURIComponent(bare.slice("/uploads/".length));
    if (!fileName || /[/\\\u0000-\u001f]/.test(fileName) || fileName === "." || fileName === ".." || fileName.includes(":")) return null;
    return fileName;
  } catch {
    return null;
  }
}

type UploadInfo = {
  fileName: string;
  size: number;
  mtime: Date;
  etag: string;
  image: boolean;
  mime: string;
};

const uploadInfoCache = new Map<string, { info: UploadInfo; at: number }>();
const uploadInfoJobs = new Map<string, Promise<UploadInfo | null>>();
const UPLOAD_INFO_TTL_MS = 60_000;

export function forgetUploadInfo(fileName: string) {
  if (fileName) uploadInfoCache.delete(fileName);
}

export async function getUploadInfo(url: string) {
  const fileName = uploadNameFromUrl(url);
  if (!fileName) return null;
  const cached = uploadInfoCache.get(fileName);
  if (cached && Date.now() - cached.at < UPLOAD_INFO_TTL_MS) return cached.info;
  let job = uploadInfoJobs.get(fileName);
  if (!job) {
    job = readUploadInfo(fileName).finally(() => uploadInfoJobs.delete(fileName));
    uploadInfoJobs.set(fileName, job);
  }
  const info = await job;
  if (uploadInfoCache.size >= 2048) uploadInfoCache.delete(uploadInfoCache.keys().next().value!);
  if (info) uploadInfoCache.set(fileName, { info, at: Date.now() });
  return info;
}

async function readUploadInfo(fileName: string): Promise<UploadInfo | null> {
  if (s3Enabled) {
    const stored = await headObject(`uploads/${fileName}`);
    if (!stored) return null;
    return {
      fileName, size: stored.ContentLength || 0,
      mtime: stored.LastModified || new Date(0),
      etag: stored.ETag || "",
      image: stored.Metadata?.image === "true",
      mime: stored.ContentType || mimeFromName(fileName),
    };
  }
  const full = path.join(UPLOAD_DIR, fileName);
  try {
    const stat = statSync(full);
    if (!stat.isFile()) return null;
    return { fileName, size: stat.size, mtime: stat.mtime,
      etag: `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
      image: looksLikeImage(full), mime: mimeFromName(fileName) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function withUploadFile<T>(url: string, consume: (filename: string) => Promise<T> | T) {
  const fileName = uploadNameFromUrl(url);
  if (!fileName) throw new Error("Invalid upload URL");
  return s3Enabled
    ? withObjectFile(`uploads/${fileName}`, consume)
    : consume(path.join(UPLOAD_DIR, fileName));
}

async function pipeUpload(
  fileName: string,
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number>,
  range?: { start: number; end: number },
) {
  const abort = new AbortController();
  const close = () => abort.abort();
  res.once("close", close);
  try {
    const stream = s3Enabled
      ? (await readObject(`uploads/${fileName}`, range, abort.signal, String(headers.ETag || "") || undefined)).body
      : createReadStream(path.join(UPLOAD_DIR, fileName), { ...range, highWaterMark: 256 * 1024 });
    if (res.destroyed) { stream.destroy(); return; }
    res.writeHead(status, headers);
    await pipeline(stream, res);
  } finally {
    res.off("close", close);
  }
}

/** Delete uploads nothing references, older than ORPHAN_MIN_AGE_MS. */
const ORPHAN_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isJpegFile(filePath: string) {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(3);
    const n = readSync(fd, buf, 0, 3, 0);
    closeSync(fd);
    return n >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
  } catch {
    return false;
  }
}

/** ffmpeg resize off the request path so the first view is not stuck on a thumb. */
function resizeThumb(source: string, target: string, width: number) {
  const tmp = `${target}.tmp`;
  const side = Math.max(32, Math.min(1080, Math.round(width) || 430));
  return new Promise<boolean>((resolve) => {
    let stderr = "";
    let settled = false;
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        source,
        "-vf",
        `scale=${side}:-2`,
        "-frames:v",
        "1",
        "-q:v",
        "5",
        "-update",
        "1",
        "-f",
        "image2",
        tmp,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 15_000);
    function finish(ok: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
      resolve(ok);
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-200);
    });
    child.on("error", (error) => {
      console.error("[thumbs] spawn error", error.message);
      finish(false);
    });
    child.on("close", (status) => {
      if (status === 0 && existsSync(tmp) && isJpegFile(tmp)) {
        try {
          renameSync(tmp, target);
          finish(true);
          return;
        } catch (error) {
          console.error("[thumbs] rename failed", (error as Error).message);
        }
      } else if (status !== 0) {
        console.error("[thumbs] ffmpeg failed", "status:", status, "stderr:", stderr);
      }
      finish(false);
    });
  });
}

export function sweepOrphanUploads(
  isReferenced: (fileName: string) => boolean,
  now = Date.now(),
): { removed: number; freedBytes: number } {
  // In S3 mode local originals are a rollback backup, not an orphan cache.
  // Remote retention must include group avatars and installed sticker packs.
  if (s3Enabled) return { removed: 0, freedBytes: 0 };
  let removed = 0;
  let freedBytes = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(UPLOAD_DIR);
  } catch {
    return { removed, freedBytes };
  }
  for (const name of entries) {
    if (isReferenced(name)) continue;
    const full = path.join(UPLOAD_DIR, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (now - info.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
    try {
      unlinkSync(full);
      removed += 1;
      freedBytes += info.size;
    } catch {
      /* busy or already gone */
    }
  }
  return { removed, freedBytes };
}

export function tryServeUpload(req: IncomingMessage, res: ServerResponse) {
  const url = req.url || "";
  if (!url.startsWith("/uploads/")) return false;
  void serveUpload(req, res).catch((error) => {
    if (res.destroyed) return;
    console.error("[uploads] read failed", (error as Error).name);
    if (res.headersSent) { res.destroy(); return; }
    res.statusCode = isObjectNotFound(error) ? 404 : 503;
    res.setHeader("Cache-Control", "no-store");
    res.end(res.statusCode === 404 ? "Not found" : "Media storage unavailable");
  });
  return true;
}

async function serveUpload(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }
  const url = req.url || "";

  const parsed = new URL(url, "http://localhost");
  const info = await getUploadInfo(parsed.pathname);
  const fileName = info?.fileName || "";
  const bare = `/uploads/${fileName}`;
  if (!info) {
    res.statusCode = 404;
    res.setHeader("Cache-Control", "no-store");
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
  const looksImage = info.image;
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
      res.setHeader("Cache-Control", "no-store");
      res.end("Forbidden");
      return true;
    }
  }

  const size = info.size;
  if (parsed.searchParams.get("waveform") === "1") {
    if (size > 64 * 1024 * 1024 || !INLINE_MEDIA_EXT.has(ext) || looksImage) {
      res.writeHead(422, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const waveform = await audioWaveform(fileName, (consume) => withUploadFile(bare, consume));
    if (res.destroyed) return;
    if (!waveform) {
      res.writeHead(503, { "Cache-Control": "no-store", "Retry-After": "5" });
      res.end();
      return;
    }
    const body = JSON.stringify(waveform);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  const isVoiceName = /^voice[-_]/i.test(original);
  let mime = info.mime;
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
  if (ext === ".webm" && !isVoiceName && !mime.startsWith("audio/") && mime !== "video/mp4") {
    mime = "video/webm";
  }

  const forceAttach = download || !INLINE_MEDIA_EXT.has(ext);
  const disposition = `${forceAttach ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(original)}`;
  const isVideo = mime.startsWith("video/");

  // Thumbnail proxy: a ready thumb is served immediately. A miss falls
  // through to the original so the chat is not stuck on ffmpeg.
  const wantW = parsed.searchParams.get("w");
  if (
    wantW &&
    THUMB_WIDTHS.has(wantW) &&
    looksImage &&
    THUMB_SOURCE_EXT.has(ext) &&
    size > 120_000
  ) {
    const thumbName = `${fileName}.w${wantW}.jpg`;
    const thumbSize = await readyThumbnailSize(thumbName);
    if (thumbSize <= 0) scheduleThumbnail(fileName, thumbName, Number(wantW));
    if (thumbSize > 0) {
      const headers = {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Length": thumbSize,
          "X-Content-Type-Options": "nosniff",
      };
      if (req.method === "HEAD") { res.writeHead(200, headers); res.end(); }
      else await pipeUpload(`thumbs/${thumbName}`, res, 200, headers);
      return true;
    }
  }
  // Videos are often replaced after HEVC→H.264 — short cache + ETag so PC
  // browsers pick up the converted file instead of a stale audio-only copy.
  const etag = info.etag;
  const cacheControl = isVideo || !isInlineVisual
    ? "private, max-age=60, must-revalidate"
    : "public, max-age=31536000, immutable";

  const baseHeaders: Record<string, string | number> = {
    "Content-Type": mime,
    "Cache-Control": cacheControl,
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
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
    await pipeUpload(fileName, res, 206, {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": chunkSize,
    }, { start, end });
    return true;
  }

  await pipeUpload(fileName, res, 200, { ...baseHeaders, "Content-Length": size });
  return true;
}

const thumbnailJobs = new Map<string, Promise<void>>();

async function readyThumbnailSize(thumbName: string) {
  const key = `uploads/thumbs/${thumbName}`;
  const target = path.join(THUMB_DIR, thumbName);
  if (s3Enabled) {
    const remote = await headObject(key);
    return remote?.ContentLength || 0;
  }
  if (existsSync(target) && isJpegFile(target)) return statSync(target).size;
  return 0;
}

function scheduleThumbnail(fileName: string, thumbName: string, width: number) {
  if (thumbnailJobs.has(thumbName)) return;
  if (!rateLimit("thumb-gen", 120, 60_000)) return;
  const job = (async () => {
    const key = `uploads/thumbs/${thumbName}`;
    const target = path.join(THUMB_DIR, thumbName);
    if ((await readyThumbnailSize(thumbName)) > 0) return;
    try {
      const ok = await withUploadFile(`/uploads/${fileName}`, (source) =>
        resizeThumb(source, target, width),
      );
      if (!ok) return;
      if (s3Enabled) await putObjectFile(key, target, "image/jpeg", { image: "true" });
    } catch (error) {
      console.error("[thumbs] generate failed", (error as Error).name);
    } finally {
      if (s3Enabled) cleanupPath(target);
    }
  })().finally(() => thumbnailJobs.delete(thumbName));
  thumbnailJobs.set(thumbName, job);
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

  const directAction = parsed.pathname.startsWith(DIRECT_PREFIX)
    ? parsed.pathname.slice(DIRECT_PREFIX.length)
    : "";
  const clientKey =
    String(req.socket.remoteAddress || "unknown") +
    ":" +
    session.account.userId;
  if (
    (!directAction || directAction === "start") &&
    !rateLimit(`upload:${clientKey}`, 30, 60_000)
  ) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Слишком много загрузок" }));
    return;
  }
  if (directAction) {
    void handleDirectUpload(req, res, directAction, session.account.userId).catch((error) => {
      console.error("[upload] direct failed", (error as Error).name);
      sendJson(res, 503, { ok: false, error: "Хранилище недоступно" });
    });
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
          let transcode = false;

          // Respond immediately; HEVC→H.264 runs in background and replaces the file.
          if (!isAvatar && isTranscodableVideoPath(full, savedMime)) {
            try {
              const normalized = normalizeVideoUploadPath(full, savedMime);
              finalPath = normalized.path;
              finalStored = path.basename(normalized.path);
              savedMime = normalized.mime || savedMime;
              storedPath = finalPath;
              transcode = true;
            } catch (error) {
              console.warn("[upload] video normalize skipped", error);
            }
          }

          if (s3Enabled) {
            await putObjectFile(`uploads/${finalStored}`, finalPath, savedMime, {
              image: String(looksLikeImage(finalPath)),
            });
            forgetUploadInfo(finalStored);
          }
          const displaySource = originalNameField || original;
          saved = {
            url: `/uploads/${finalStored}`,
            name: ensureMediaExtension(displaySource, savedMime),
            size: finalSize,
            mime: savedMime,
          };
          const wavePromise =
            savedMime.startsWith("audio/") && finalSize <= 64 * 1024 * 1024
              ? audioWaveform(finalStored, (consume) => consume(finalPath))
              : null;
          if (transcode) {
            scheduleBrowserVideoTranscode(finalPath, savedMime, async (convertedPath, changed) => {
              if (changed) forgetUploadInfo(finalStored);
              if (!s3Enabled) return;
              if (changed) {
                await putObjectFile(`uploads/${finalStored}`, convertedPath, "video/mp4", { image: "false" });
              }
              cleanupPath(convertedPath);
              if (convertedPath !== finalPath) cleanupPath(finalPath);
            });
          } else if (s3Enabled) {
            if (wavePromise) void wavePromise.finally(() => cleanupPath(finalPath));
            else cleanupPath(finalPath);
          }
          resolve();
        })().catch((error) => {
          console.error("[upload] storage failed", (error as Error).name);
          writeError = error instanceof Error ? error : new Error("Storage failed");
          saved = null;
          cleanupPath(storedPath);
          resolve();
        });
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

// Direct browser → S3 uploads: the server signs exact-size part URLs, the
// browser PUTs parts to the bucket, then /complete verifies the object.
const DIRECT_PREFIX = "/api/upload/direct/";
const DIRECT_PART_SIZE = 16 * 1024 * 1024;
const DIRECT_TTL_MS = 60 * 60 * 1000;
const DIRECT_MAX_PENDING_PER_USER = 12;
const DIRECT_FILE = path.join(DATA_DIR, "direct-uploads.json");

type DirectUpload = {
  userId: string;
  stored: string;
  uploadId: string;
  size: number;
  parts: number;
  mime: string;
  name: string;
  image: boolean;
  expiresAt: number;
};

const directUploads = new Map<string, DirectUpload>();

function saveDirectUploads() {
  try {
    writeFileSync(DIRECT_FILE, JSON.stringify(Object.fromEntries(directUploads)), "utf8");
  } catch {
    /* ignore */
  }
}

function loadDirectUploads() {
  try {
    if (!existsSync(DIRECT_FILE)) return;
    const raw = JSON.parse(readFileSync(DIRECT_FILE, "utf8")) as Record<string, DirectUpload>;
    for (const [id, upload] of Object.entries(raw)) {
      if (upload?.stored && upload.uploadId) directUploads.set(id, upload);
    }
  } catch {
    /* ignore */
  }
}

/** Forget the ticket first so a concurrent /complete cannot reuse it. */
function takeDirectUpload(id: string) {
  const upload = directUploads.get(id);
  if (!upload) return null;
  directUploads.delete(id);
  saveDirectUploads();
  return upload;
}

async function discardDirectUpload(upload: DirectUpload) {
  const key = `uploads/${upload.stored}`;
  await abortMultipartUpload(key, upload.uploadId).catch(() => undefined);
  if (!uploadOwners.has(`/uploads/${upload.stored}`)) {
    await deleteObject(key).catch(() => undefined);
  }
}

function sweepDirectUploads(now = Date.now()) {
  for (const [id, upload] of directUploads) {
    if (upload.expiresAt > now) continue;
    takeDirectUpload(id);
    void discardDirectUpload(upload);
  }
}

if (s3Enabled) {
  loadDirectUploads();
  setTimeout(() => sweepDirectUploads(), 30_000).unref();
  setInterval(() => sweepDirectUploads(), 10 * 60_000).unref();
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        resolve(value && typeof value === "object" ? (value as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function scheduleStoredVideoTranscode(stored: string, mime: string) {
  if (path.extname(stored).toLowerCase() === ".webm" && mime.startsWith("audio/")) return;
  const key = `uploads/${stored}`;
  void (async () => {
    const source = await downloadObjectToTemp(key);
    scheduleBrowserVideoTranscode(source, mime, async (convertedPath, changed) => {
      if (changed) {
        await putObjectFile(key, convertedPath, "video/mp4", { image: "false" });
        forgetUploadInfo(stored);
      }
      cleanupPath(convertedPath);
      if (convertedPath !== source) cleanupPath(source);
    });
  })().catch((error) => console.warn("[video] direct upload transcode skipped", (error as Error).name));
}

async function handleDirectUpload(
  req: IncomingMessage,
  res: ServerResponse,
  action: string,
  userId: string,
) {
  if (!s3Enabled) {
    sendJson(res, 404, { ok: false, direct: false });
    return;
  }
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: "Неверный запрос загрузки" });
    return;
  }

  if (action === "start") {
    const rawName = String(body.name || "file")
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .slice(0, 120);
    const rawMime = String(body.type || "").slice(0, 120) || "application/octet-stream";
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
      sendJson(res, 400, { ok: false, error: "Неверный размер файла" });
      return;
    }
    if (size > MAX_SIZE) {
      sendJson(res, 413, { ok: false, error: "Файл больше 500 МБ" });
      return;
    }
    const original = ensureMediaExtension(rawName || "file", rawMime);
    if (isBlockedUpload(original, rawMime)) {
      sendJson(res, 400, { ok: false, error: "Этот тип файла запрещён" });
      return;
    }
    let pending = 0;
    for (const upload of directUploads.values()) if (upload.userId === userId) pending += 1;
    if (pending >= DIRECT_MAX_PENDING_PER_USER) {
      sendJson(res, 429, { ok: false, error: "Слишком много загрузок" });
      return;
    }

    const storedExt =
      path.extname(original).toLowerCase() ||
      path.extname(ensureMediaExtension("file", rawMime)).toLowerCase() ||
      ".bin";
    let stored = `${randomUUID()}${storedExt}`;
    let mime = resolveUploadMime(original, rawMime.split(";")[0].trim().toLowerCase());
    if (isTranscodableVideoPath(stored, mime)) {
      const normalized = normalizedVideoName(stored, mime);
      stored = normalized.name;
      mime = normalized.mime;
    }
    const image = INLINE_IMAGE_EXT.has(path.extname(original).toLowerCase());
    const key = `uploads/${stored}`;
    const uploadId = await createMultipartUpload(key, mime, { image: String(image) });
    const partCount = Math.ceil(size / DIRECT_PART_SIZE);
    const expiresIn = Math.floor(DIRECT_TTL_MS / 1000);
    const parts = await Promise.all(
      Array.from({ length: partCount }, async (_, index) => {
        const partSize = Math.min(DIRECT_PART_SIZE, size - index * DIRECT_PART_SIZE);
        return {
          partNumber: index + 1,
          size: partSize,
          url: await presignUploadPart(key, uploadId, index + 1, partSize, expiresIn),
        };
      }),
    );
    const id = randomUUID();
    directUploads.set(id, {
      userId,
      stored,
      uploadId,
      size,
      parts: partCount,
      mime,
      name: ensureMediaExtension(rawName || original, mime),
      image,
      expiresAt: Date.now() + DIRECT_TTL_MS,
    });
    saveDirectUploads();
    sendJson(res, 200, { ok: true, direct: true, id, partSize: DIRECT_PART_SIZE, parts });
    return;
  }

  const id = String(body.id || "");
  const known = directUploads.get(id);
  if (!known || known.userId !== userId) {
    sendJson(res, 404, { ok: false, error: "Загрузка не найдена" });
    return;
  }
  const upload = takeDirectUpload(id)!;

  if (action === "abort") {
    await discardDirectUpload(upload);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (action !== "complete") {
    directUploads.set(id, upload);
    saveDirectUploads();
    sendJson(res, 404, { ok: false, error: "Неизвестное действие" });
    return;
  }

  const parts = Array.isArray(body.parts) ? body.parts : [];
  const valid =
    parts.length === upload.parts &&
    parts.every((part, index) => {
      const item = part as { partNumber?: unknown; etag?: unknown };
      return (
        item?.partNumber === index + 1 &&
        typeof item.etag === "string" &&
        item.etag.length > 0 &&
        item.etag.length <= 200
      );
    });
  if (!valid) {
    await discardDirectUpload(upload);
    sendJson(res, 400, { ok: false, error: "Не удалось сохранить файл" });
    return;
  }

  const key = `uploads/${upload.stored}`;
  try {
    await completeMultipartUpload(
      key,
      upload.uploadId,
      (parts as Array<{ partNumber: number; etag: string }>).map((part) => ({
        partNumber: part.partNumber,
        etag: part.etag,
      })),
    );
    const stored = await headObject(key);
    if (!stored || stored.ContentLength !== upload.size) {
      throw new Error("Size mismatch");
    }
    if (upload.image && !looksLikeImageBytes(await readObjectPrefix(key, IMAGE_SNIFF_BYTES))) {
      await discardDirectUpload(upload);
      sendJson(res, 400, { ok: false, error: "Файл не похож на изображение" });
      return;
    }
  } catch (error) {
    console.error("[upload] direct complete failed", (error as Error).name);
    await discardDirectUpload(upload);
    sendJson(res, 400, { ok: false, error: "Не удалось сохранить файл" });
    return;
  }

  const url = `/uploads/${upload.stored}`;
  rememberUploadOwner(url, userId);
  if (isTranscodableVideoPath(upload.stored, upload.mime)) {
    scheduleStoredVideoTranscode(upload.stored, upload.mime);
  }
  sendJson(res, 200, {
    ok: true,
    file: { url: signUploadUrl(url), name: upload.name, size: upload.size, mime: upload.mime },
  });
}
