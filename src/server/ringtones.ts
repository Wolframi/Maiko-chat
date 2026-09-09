import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse as parseUrl } from "node:url";
import { rateLimit } from "./rateLimit";
import {
  fadeFilter,
  findDynamicStartSecAsync,
  HOOK_CACHE_VERSION,
  RINGTONE_CLIP_SEC,
} from "./ringtoneHook";

export { findDynamicStartSec } from "./ringtoneHook";

const ORIGIN = "https://zvukogram.com";
const CATEGORY_PATH = "/category/y2k-2000/";
const CATEGORY_ID = "3105";
const CATEGORY_TAG = "y2k-2000";
const PAGE_LIMIT = 50;
const CACHE_TTL_MS = 20 * 60 * 1000;
const MAX_PAGE = 20;
const PROXY_MAX_BYTES = 12 * 1024 * 1024;
/** Disk mirror for hosts that cannot reach zvukogram (outbound TLS blocked). */
const MIRROR_DIR = path.join(process.cwd(), "data", "ringtones");
const PAGES_DIR = path.join(MIRROR_DIR, "pages");
const AUDIO_DIR = path.join(MIRROR_DIR, "audio");
const PEAKS_DIR = path.join(MIRROR_DIR, "peaks");

export type RingtoneItem = {
  id: string;
  title: string;
  /** Absolute mp3 URL on zvukogram. */
  audioUrl: string;
  /** Same-origin proxy path for <audio> / fetch. */
  url: string;
  /** Seconds — start playback at the loudest/most dynamic section. */
  startSec: number;
};

function proxyPath(remoteUrl: string) {
  return `/api/ringtones/audio?u=${encodeURIComponent(remoteUrl)}`;
}

type PageCache = {
  expires: number;
  items: RingtoneItem[];
  pages: number;
};

const pageCache = new Map<number, PageCache>();
const audioJobs = new Map<
  string,
  Promise<{ buffer: Buffer; contentType: string; startSec: number }>
>();
const clipJobs = new Map<string, Promise<Buffer | null>>();

function tmpAudioPath(prefix: string) {
  return path.join(
    tmpdir(),
    `${prefix}-${process.pid}-${randomBytes(6).toString("hex")}.mp3`,
  );
}

function audioKey(remoteUrl: string) {
  return createHash("sha1").update(remoteUrl).digest("hex");
}

function ensureMirrorDirs() {
  mkdirSync(PAGES_DIR, { recursive: true });
  mkdirSync(AUDIO_DIR, { recursive: true });
  mkdirSync(PEAKS_DIR, { recursive: true });
}

function readPageMirror(
  page: number,
): { items: RingtoneItem[]; pages: number } | null {
  const file = path.join(PAGES_DIR, `${page}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      items?: RingtoneItem[];
      pages?: number;
    };
    if (!Array.isArray(raw.items) || raw.items.length === 0) return null;
    const items = raw.items.map((item) => ({
      ...item,
      // Audio proxy serves a clip already starting at the drop.
      startSec: 0,
      url: item.url || proxyPath(item.audioUrl),
    }));
    return { items, pages: Math.max(1, Number(raw.pages) || 1) };
  } catch {
    return null;
  }
}

function writePageMirror(page: number, items: RingtoneItem[], pages: number) {
  try {
    ensureMirrorDirs();
    writeFileSync(
      path.join(PAGES_DIR, `${page}.json`),
      JSON.stringify({ items, pages }),
      "utf8",
    );
  } catch (error) {
    console.error("[ringtones:mirror:page]", error);
  }
}

function readLocalAudio(remoteUrl: string): Buffer | null {
  const file = path.join(AUDIO_DIR, `${audioKey(remoteUrl)}.mp3`);
  if (!existsSync(file)) return null;
  try {
    const buf = readFileSync(file);
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

function writeLocalAudio(remoteUrl: string, buffer: Buffer) {
  try {
    ensureMirrorDirs();
    writeFileSync(path.join(AUDIO_DIR, `${audioKey(remoteUrl)}.mp3`), buffer);
  } catch (error) {
    console.error("[ringtones:mirror:audio]", error);
  }
}

function readPeakStart(
  remoteUrl: string,
): { startSec: number; durationSec?: number } | null {
  const file = path.join(PEAKS_DIR, `${audioKey(remoteUrl)}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      startSec?: number;
      durationSec?: number;
      v?: number;
    };
    if (Number(raw.v) !== HOOK_CACHE_VERSION) return null;
    const n = Number(raw.startSec);
    if (!Number.isFinite(n) || n < 0) return null;
    const durationSec = Number(raw.durationSec);
    return {
      startSec: n,
      durationSec:
        Number.isFinite(durationSec) && durationSec > 0
          ? durationSec
          : undefined,
    };
  } catch {
    return null;
  }
}

function writePeakStart(
  remoteUrl: string,
  startSec: number,
  durationSec: number,
) {
  try {
    ensureMirrorDirs();
    writeFileSync(
      path.join(PEAKS_DIR, `${audioKey(remoteUrl)}.json`),
      JSON.stringify({ v: HOOK_CACHE_VERSION, startSec, durationSec }),
      "utf8",
    );
  } catch (error) {
    console.error("[ringtones:mirror:peak]", error);
  }
}

function runFfmpegPcm(inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "22050",
        "-f",
        "s16le",
        "-",
      ],
      { windowsHide: true },
    );
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    let err = "";
    proc.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `ffmpeg exit ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function detectPeakStart(
  remoteUrl: string,
  buffer: Buffer,
): Promise<{ startSec: number; durationSec: number }> {
  const cached = readPeakStart(remoteUrl);
  if (cached && cached.durationSec && cached.durationSec > 0) {
    return { startSec: cached.startSec, durationSec: cached.durationSec };
  }
  const tmp = tmpAudioPath(`pulse-rt-${audioKey(remoteUrl).slice(0, 10)}`);
  try {
    writeFileSync(tmp, buffer);
    const pcm = await runFfmpegPcm(tmp);
    const durationSec = pcm.byteLength / 2 / 22050;
    const startSec =
      cached?.startSec ?? (await findDynamicStartSecAsync(pcm));
    writePeakStart(remoteUrl, startSec, durationSec);
    return { startSec, durationSec };
  } catch (error) {
    console.error("[ringtones:peak]", error);
    return {
      startSec: cached?.startSec ?? 0,
      durationSec: RINGTONE_CLIP_SEC,
    };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function fromPeakPath(remoteUrl: string) {
  return path.join(
    AUDIO_DIR,
    `${audioKey(remoteUrl)}.hook-v${HOOK_CACHE_VERSION}.mp3`,
  );
}

function runFfmpegCut(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec = RINGTONE_CLIP_SEC,
): Promise<void> {
  const clipSec = Math.max(0.25, durationSec);
  const filter = fadeFilter(clipSec);
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-ss",
        String(Math.max(0, startSec)),
        "-i",
        inputPath,
        "-t",
        String(clipSec),
        "-af",
        filter,
        "-c:a",
        "libmp3lame",
        "-q:a",
        "5",
        outputPath,
      ],
      { windowsHide: true },
    );
    let err = "";
    proc.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `ffmpeg cut exit ${code}`));
        return;
      }
      resolve();
    });
  });
}

/** Cache a ringtone clip that already starts at the dynamic section. */
function readPreparedClip(remoteUrl: string): Buffer | null {
  const out = fromPeakPath(remoteUrl);
  if (!existsSync(out)) return null;
  try {
    const cached = readFileSync(out);
    return cached.byteLength > 1000 ? cached : null;
  } catch {
    return null;
  }
}

async function buildPreparedClip(
  remoteUrl: string,
  full: Buffer,
): Promise<Buffer | null> {
  ensureMirrorDirs();
  const existing = readPreparedClip(remoteUrl);
  if (existing) return existing;
  const { startSec, durationSec } = await detectPeakStart(remoteUrl, full);
  const clipSec = Math.min(
    RINGTONE_CLIP_SEC,
    Math.max(0.5, durationSec - Math.max(0, startSec)),
  );
  const out = fromPeakPath(remoteUrl);
  const tmpIn = tmpAudioPath(`pulse-rt-in-${audioKey(remoteUrl).slice(0, 10)}`);
  try {
    writeFileSync(tmpIn, full);
    await runFfmpegCut(tmpIn, out, startSec, clipSec);
    return readPreparedClip(remoteUrl);
  } catch (error) {
    console.error("[ringtones:cut]", error);
    return null;
  } finally {
    try {
      unlinkSync(tmpIn);
    } catch {
      /* ignore */
    }
  }
}

function clipJob(remoteUrl: string, full: Buffer): Promise<Buffer | null> {
  const existing = clipJobs.get(remoteUrl);
  if (existing) return existing;
  const job = buildPreparedClip(remoteUrl, full).finally(() => {
    setTimeout(() => {
      if (clipJobs.get(remoteUrl) === job) clipJobs.delete(remoteUrl);
    }, 1500);
  });
  clipJobs.set(remoteUrl, job);
  return job;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function materializeFromPeak(
  remoteUrl: string,
  full: Buffer,
): Promise<{ buffer: Buffer; startSec: number }> {
  ensureMirrorDirs();
  const cached = readPreparedClip(remoteUrl);
  if (cached) return { buffer: cached, startSec: 0 };
  const prepared = await Promise.race([
    clipJob(remoteUrl, full).catch((error) => {
      console.error("[ringtones:clip]", error);
      return null;
    }),
    sleep(4500).then(() => null),
  ]);
  if (prepared) return { buffer: prepared, startSec: 0 };
  return { buffer: full, startSec: 0 };
}

function clientIp(req: IncomingMessage) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "unknown";
}

function decodeHtml(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteMediaUrl(src: string) {
  if (src.startsWith("https://") || src.startsWith("http://")) return src;
  if (src.startsWith("//")) return `https:${src}`;
  if (!src.startsWith("/")) return `${ORIGIN}/${src}`;
  return `${ORIGIN}${src}`;
}

/** Only allow mp3 under zvukogram.com/mp3/cats/ (SSRF allowlist). */
export function isAllowedRingtoneUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== "zvukogram.com" && host !== "www.zvukogram.com") return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== "443") return false;
    const p = parsed.pathname.replace(/\\/g, "/");
    if (p.includes("..") || /%2e/i.test(p)) return false;
    if (!p.toLowerCase().startsWith("/mp3/cats/")) return false;
    if (!p.toLowerCase().endsWith(".mp3")) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeRemoteUrl(raw: string) {
  if (!isAllowedRingtoneUrl(raw)) return null;
  const parsed = new URL(raw);
  parsed.hostname = "zvukogram.com";
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

function parseRingtoneHtml(html: string): RingtoneItem[] {
  const items: RingtoneItem[] = [];
  const seen = new Set<string>();
  const openRe =
    /<div class="onetrack accordion"[^>]*data-id="(\d+)"[^>]*data-duration="(\d+)"[^>]*data-track="([^"]+\.mp3)"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(html))) {
    const id = match[1];
    const remoteUrl = normalizeRemoteUrl(absoluteMediaUrl(match[3]));
    if (!remoteUrl) continue;
    const chunkEnd = match.index + match[0].length;
    const chunk = html.slice(chunkEnd, chunkEnd + 1200);
    const titleMatch =
      /class="waveTitle"[^>]*data-full="([^"]*)"/i.exec(chunk) ||
      /class="waveTitle"[^>]*>([\s\S]*?)<\//i.exec(chunk);
    const title = decodeHtml(
      (titleMatch?.[1] || "").replace(/<[^>]+>/g, ""),
    ) || `Трек ${id}`;
    if (seen.has(remoteUrl)) continue;
    seen.add(remoteUrl);
    items.push({
      id: remoteUrl,
      title,
      audioUrl: remoteUrl,
      url: proxyPath(remoteUrl),
      // Playback uses a from-peak clip from /api/ringtones/audio — seek is 0.
      startSec: 0,
    });
  }
  return items;
}

async function fetchCategoryHtml() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${ORIGIN}${CATEGORY_PATH}?sort=popular`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; PulseChat/1.0; +https://localhost)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Каталог недоступен (${res.status})`);
      const finalHost = new URL(res.url).hostname.toLowerCase();
      if (finalHost !== "zvukogram.com" && finalHost !== "www.zvukogram.com") {
        throw new Error("Каталог недоступен");
      }
      return res.text();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Каталог недоступен");
}

async function fetchCategoryAjax(page: number) {
  const params = new URLSearchParams({
    category_id: CATEGORY_ID,
    tag: CATEGORY_TAG,
    sort: "popular",
    page: String(page),
    limit: String(PAGE_LIMIT),
  });
  const url = `${ORIGIN}/index.php?r=categoryV3/categoryTracksAjax&${params}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; PulseChat/1.0; +https://localhost)",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${ORIGIN}${CATEGORY_PATH}?sort=popular`,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Каталог недоступен (${res.status})`);
  const data = (await res.json()) as {
    status?: number;
    html?: string;
    page?: number;
    hasMore?: boolean;
    total?: number;
    error?: string;
  };
  if (!data?.status) {
    throw new Error(data?.error || "Каталог недоступен");
  }
  const total = Number(data.total) || 0;
  const pages =
    total > 0
      ? Math.min(MAX_PAGE, Math.max(1, Math.ceil(total / PAGE_LIMIT)))
      : data.hasMore
        ? Math.min(MAX_PAGE, page + 1)
        : page;
  return { html: String(data.html || ""), pages };
}

async function refreshFromRemote(safePage: number) {
  let html: string;
  let pages: number;
  if (safePage <= 1) {
    html = await fetchCategoryHtml();
    // Probe total via ajax page 1 metadata when possible.
    try {
      const meta = await fetchCategoryAjax(1);
      pages = meta.pages;
      // Prefer first-page HTML from the category document (same tracks).
    } catch {
      pages = safePage;
    }
  } else {
    const ajax = await fetchCategoryAjax(safePage);
    html = ajax.html;
    pages = ajax.pages;
  }
  const items = parseRingtoneHtml(html);
  pages = Math.max(pages, safePage);
  pageCache.set(safePage, {
    expires: Date.now() + CACHE_TTL_MS,
    items,
    pages,
  });
  writePageMirror(safePage, items, pages);
  return { items, pages };
}

function warmupCatalogAudio(items: RingtoneItem[]) {
  items.slice(0, 10).forEach((item, index) => {
    setTimeout(() => {
      void proxyRingtoneAudio(item.audioUrl).catch(() => undefined);
    }, 300 * index);
  });
}

function uniqueCatalog(items: RingtoneItem[]): RingtoneItem[] {
  const seen = new Set<string>();
  const out: RingtoneItem[] = [];
  for (const item of items) {
    const id = item.id || item.audioUrl || item.url;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...item, id });
  }
  return out;
}

export async function listRingtones(page = 1) {
  const safePage = Math.max(1, Math.min(MAX_PAGE, Math.floor(page) || 1));
  const cached = pageCache.get(safePage);
  if (cached && cached.expires > Date.now()) {
    const items = uniqueCatalog(cached.items);
    warmupCatalogAudio(items);
    return {
      items,
      page: safePage,
      pages: cached.pages,
      source: "zvukogram.com",
    };
  }

  const mirrored = readPageMirror(safePage);
  if (mirrored) {
    pageCache.set(safePage, {
      expires: Date.now() + CACHE_TTL_MS,
      items: mirrored.items,
      pages: mirrored.pages,
    });
    void refreshFromRemote(safePage).catch(() => {
      /* keep mirror */
    });
    const items = uniqueCatalog(mirrored.items);
    warmupCatalogAudio(items);
    return {
      items,
      page: safePage,
      pages: mirrored.pages,
      source: "mirror",
    };
  }

  const fresh = await refreshFromRemote(safePage);
  const items = uniqueCatalog(fresh.items);
  warmupCatalogAudio(items);
  return {
    items,
    page: safePage,
    pages: fresh.pages,
    source: "zvukogram.com",
  };
}

async function downloadRemoteAudio(target: string) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (compatible; PulseChat/1.0; +https://localhost)",
    Accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.5",
    Referer: `${ORIGIN}${CATEGORY_PATH}`,
  };
  const res = await fetch(target, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });

  let final = res;
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get("location");
    const next = loc
      ? normalizeRemoteUrl(new URL(loc, target).toString())
      : null;
    if (!next) throw new Error("Аудио недоступно");
    final = await fetch(next, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  }

  if (!final.ok) {
    throw new Error(`Аудио недоступно (${final.status})`);
  }
  const len = Number(final.headers.get("content-length") || 0);
  if (len > PROXY_MAX_BYTES) {
    throw new Error("Файл слишком большой");
  }
  const buffer = Buffer.from(await final.arrayBuffer());
  if (buffer.byteLength > PROXY_MAX_BYTES) {
    throw new Error("Файл слишком большой");
  }
  return { buffer, contentType: final.headers.get("content-type") || "audio/mpeg" };
}

async function proxyRingtoneAudioOnce(target: string) {
  const local = readLocalAudio(target);
  if (local) {
    const prepared = await materializeFromPeak(target, local);
    return { ...prepared, contentType: "audio/mpeg" };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { buffer, contentType } = await downloadRemoteAudio(target);
      writeLocalAudio(target, buffer);
      const prepared = await materializeFromPeak(target, buffer);
      return { ...prepared, contentType };
    } catch (error) {
      lastError = error;
      const again = readLocalAudio(target);
      if (again) {
        const prepared = await materializeFromPeak(target, again);
        return { ...prepared, contentType: "audio/mpeg" };
      }
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Аудио недоступно");
}

export async function proxyRingtoneAudio(remoteUrl: string) {
  const target = normalizeRemoteUrl(remoteUrl);
  if (!target) {
    throw new Error("Недопустимый адрес рингтона");
  }
  const existing = audioJobs.get(target);
  if (existing) return existing;
  const job = proxyRingtoneAudioOnce(target).finally(() => {
    if (audioJobs.get(target) === job) audioJobs.delete(target);
  });
  audioJobs.set(target, job);
  return job;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function handleRingtones(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const parsed = parseUrl(req.url || "", true);
  const pathname = parsed.pathname || "";
  const ip = clientIp(req);

  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  try {
    if (pathname === "/api/ringtones" || pathname === "/api/ringtones/") {
      if (!rateLimit(`ringtone-catalog:${ip}`, 80, 60_000)) {
        json(res, 429, { ok: false, error: "Слишком много запросов" });
        return;
      }
      const page = Number(parsed.query.page || 1);
      const data = await listRingtones(page);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=60");
      res.end(JSON.stringify({ ok: true, ...data }));
      return;
    }

    if (pathname === "/api/ringtones/audio") {
      const remote = String(parsed.query.u || "");
      const target = normalizeRemoteUrl(remote);
      const cached = target
        ? Boolean(readLocalAudio(target) || readPreparedClip(target))
        : false;
      if (!cached && !rateLimit(`ringtone-proxy:${ip}`, 90, 60_000)) {
        json(res, 429, { ok: false, error: "Слишком много запросов" });
        return;
      }
      const { buffer, contentType, startSec } =
        await proxyRingtoneAudio(remote);
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Pulse-Start-Sec", String(startSec));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(buffer);
      return;
    }

    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Ошибка каталога рингтонов";
    json(res, 502, { ok: false, error: message });
  }
}
