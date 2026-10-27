import { createHash, randomBytes } from "node:crypto";
import {
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
import { rateLimit, rateLimitRetrySeconds } from "./rateLimit";
import { handleRingtonePreference } from "./ringtonePreferences";
import { restoreSession } from "./auth";
import { RingtoneClipCache, RingtoneFileCache } from "./ringtoneClipCache";
import { clientAddress } from "./requestSecurity";
import { downloadYoutubeRingtone, normalizeRingtoneQuery, searchYoutubeRingtones, youtubeVideoId } from "./youtubeRingtones";
import { readObjectBuffer, s3Enabled } from "./objectStorage";
import { RINGTONE_ANALYSIS_RATE, ringtoneAudioPath } from "../lib/ringtoneConfig";
import {
  fadeFilter,
  findDynamicStartSecAsync,
  HOOK_CACHE_VERSION,
  RINGTONE_CLIP_SEC,
} from "./ringtoneHook";

export { findDynamicStartSec } from "./ringtoneHook";

const CACHE_TTL_MS = 20 * 60 * 1000;
const MAX_PAGE = 20;
const PROXY_MAX_BYTES = 12 * 1024 * 1024;
/** Persist catalog pages and prepared ringtone clips between restarts. */
const MIRROR_DIR = path.join(process.cwd(), "data", "ringtones");
const PAGES_DIR = path.join(MIRROR_DIR, "pages");
const AUDIO_DIR = path.join(MIRROR_DIR, "audio");
const PEAKS_DIR = path.join(MIRROR_DIR, "peaks");
const diskClips = new RingtoneClipCache(AUDIO_DIR);
const diskSources = new RingtoneFileCache(AUDIO_DIR, { pattern: /^[a-f0-9]{40}\.mp3$/, maxBytes: 128 * 1024 * 1024, maxFileBytes: PROXY_MAX_BYTES });
const diskPages = new RingtoneFileCache(PAGES_DIR, { pattern: /^youtube-[a-f0-9]{40}-\d+\.json$/, maxBytes: 4 * 1024 * 1024, maxFileBytes: 128 * 1024, ttlMs: CACHE_TTL_MS });
const diskPeaks = new RingtoneFileCache(PEAKS_DIR, { pattern: /^[a-f0-9]{40}\.json$/, maxBytes: 1024 * 1024, maxFileBytes: 1024 });
let activeSearches = 0;
let activeSources = 0;

export type RingtoneItem = {
  id: string;
  title: string;
  /** Stable YouTube watch URL (legacy saved items may reference mp3 files). */
  audioUrl: string;
  /** Same-origin proxy path for <audio> / fetch. */
  url: string;
  /** Seconds — start playback at the loudest/most dynamic section. */
  startSec: number;
};

function proxyPath(remoteUrl: string) {
  return ringtoneAudioPath(remoteUrl);
}

type PageCache = {
  expires: number;
  items: RingtoneItem[];
  pages: number;
};

const pageCache = new Map<string, PageCache>();
const audioJobs = new Map<
  string,
  Promise<{ buffer: Buffer; contentType: string; startSec: number }>
>();
const clipJobs = new Map<string, Promise<Buffer | null>>();
const sourceJobs = new Map<string, Promise<Buffer>>();
const preparedMemory = new Map<string, { buffer: Buffer; expires: number }>();
const PREPARED_MEMORY_BYTES = 16 * 1024 * 1024;
let preparedBytes = 0;
let audioWorkers = 0;
const audioQueue: Array<() => void> = [];

function rememberPrepared(key: string, buffer: Buffer) {
  const previous = preparedMemory.get(key);
  if (previous) { preparedBytes -= previous.buffer.length; preparedMemory.delete(key); }
  if (buffer.length > PREPARED_MEMORY_BYTES) return;
  while (preparedBytes + buffer.length > PREPARED_MEMORY_BYTES && preparedMemory.size) {
    const oldest = preparedMemory.keys().next().value!;
    preparedBytes -= preparedMemory.get(oldest)!.buffer.length;
    preparedMemory.delete(oldest);
  }
  preparedMemory.set(key, { buffer, expires: Date.now() + CACHE_TTL_MS });
  preparedBytes += buffer.length;
}

async function withAudioSlot<T>(work: () => Promise<T>): Promise<T> {
  if (audioWorkers >= 2 && audioQueue.length >= 4) throw new RingtoneBusyError();
  await new Promise<void>((resolve) => {
    if (audioWorkers < 2) { audioWorkers++; resolve(); }
    else audioQueue.push(resolve);
  });
  try { return await work(); }
  finally {
    const next = audioQueue.shift();
    if (next) next();
    else audioWorkers--;
  }
}

class RingtoneBusyError extends Error {
  constructor() { super("Сервис рингтонов занят. Попробуйте через минуту"); }
}

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

async function readPageMirror(
  page: string,
): Promise<{ items: RingtoneItem[]; pages: number } | null> {
  try {
    const buffer = await diskPages.read(`${page}.json`);
    if (!buffer) return null;
    const raw = JSON.parse(buffer.toString("utf8")) as {
      items?: RingtoneItem[];
      pages?: number;
    };
    if (!Array.isArray(raw.items) || raw.items.length === 0) return null;
    const items = raw.items.map((item) => ({
      ...item,
      // Audio proxy serves a clip already starting at the drop.
      startSec: 0,
      url: proxyPath(item.audioUrl),
    }));
    return { items, pages: Math.max(1, Number(raw.pages) || 1) };
  } catch {
    return null;
  }
}

async function writePageMirror(page: string, items: RingtoneItem[], pages: number) {
  try {
    await diskPages.write(`${page}.json`, Buffer.from(JSON.stringify({ items, pages })));
  } catch (error) {
    console.error("[ringtones:mirror:page]", error);
  }
}

async function readLocalAudio(remoteUrl: string): Promise<Buffer | null> {
  const name = `${audioKey(remoteUrl)}.mp3`;
  const local = await diskSources.read(name);
  if (local || !s3Enabled) return local;
  // Read existing cloud mirrors for compatibility. New cache entries stay bounded locally.
  const buffer = await readObjectBuffer(`ringtones/audio/${name}`);
  if (!buffer || buffer.length > PROXY_MAX_BYTES) return null;
  await diskSources.write(name, buffer);
  return buffer;
}

async function writeLocalAudio(remoteUrl: string, buffer: Buffer) {
  try {
    await diskSources.write(`${audioKey(remoteUrl)}.mp3`, buffer);
  } catch (error) {
    console.error("[ringtones:mirror:audio]", error);
  }
}

async function readPeakStart(
  remoteUrl: string,
): Promise<{ startSec: number; durationSec?: number } | null> {
  try {
    const buffer = await diskPeaks.read(`${audioKey(remoteUrl)}.json`);
    if (!buffer) return null;
    const raw = JSON.parse(buffer.toString("utf8")) as {
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

async function writePeakStart(
  remoteUrl: string,
  startSec: number,
  durationSec: number,
) {
  try {
    await diskPeaks.write(`${audioKey(remoteUrl)}.json`, Buffer.from(JSON.stringify({ v: HOOK_CACHE_VERSION, startSec, durationSec })));
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
        String(RINGTONE_ANALYSIS_RATE),
        "-f",
        "s16le",
        "-",
      ],
      { windowsHide: true, timeout: 30_000, killSignal: "SIGKILL" },
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
  const cached = await readPeakStart(remoteUrl);
  if (cached && cached.durationSec && cached.durationSec > 0) {
    return { startSec: cached.startSec, durationSec: cached.durationSec };
  }
  const tmp = tmpAudioPath(`pulse-rt-${audioKey(remoteUrl).slice(0, 10)}`);
  try {
    writeFileSync(tmp, buffer);
    const pcm = await runFfmpegPcm(tmp);
    const durationSec = pcm.byteLength / 2 / RINGTONE_ANALYSIS_RATE;
    const startSec =
      cached?.startSec ?? (await findDynamicStartSecAsync(pcm, RINGTONE_ANALYSIS_RATE));
    await writePeakStart(remoteUrl, startSec, durationSec);
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
      { windowsHide: true, timeout: 30_000, killSignal: "SIGKILL" },
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
async function readPreparedClip(remoteUrl: string): Promise<Buffer | null> {
  const memory = preparedMemory.get(remoteUrl);
  if (memory) {
    if (memory.expires > Date.now()) {
      preparedMemory.delete(remoteUrl);
      preparedMemory.set(remoteUrl, memory);
      return memory.buffer;
    }
    preparedBytes -= memory.buffer.length;
    preparedMemory.delete(remoteUrl);
  }
  const name = path.basename(fromPeakPath(remoteUrl));
  const local = await diskClips.read(name);
  if (local) { rememberPrepared(remoteUrl, local); return local; }
  if (!s3Enabled) return null;
  const cached = await readObjectBuffer(`ringtones/audio/${name}`);
  if (cached && cached.length > 1000 && cached.length <= 2 * 1024 * 1024) {
    rememberPrepared(remoteUrl, cached);
    await diskClips.write(name, cached).catch((error) => console.error("[ringtones:disk-cache]", error));
    return cached;
  }
  return null;
}

async function buildPreparedClip(
  remoteUrl: string,
  full: Buffer,
): Promise<Buffer | null> {
  ensureMirrorDirs();
  const { startSec, durationSec } = await detectPeakStart(remoteUrl, full);
  const clipSec = Math.min(
    RINGTONE_CLIP_SEC,
    Math.max(0.5, durationSec - Math.max(0, startSec)),
  );
  const name = path.basename(fromPeakPath(remoteUrl));
  const out = tmpAudioPath(`pulse-rt-clip-${audioKey(remoteUrl).slice(0, 10)}`);
  const tmpIn = tmpAudioPath(`pulse-rt-in-${audioKey(remoteUrl).slice(0, 10)}`);
  try {
    writeFileSync(tmpIn, full);
    await runFfmpegCut(tmpIn, out, startSec, clipSec);
    const clip = readFileSync(out);
    await diskClips.write(name, clip).catch((error) => console.error("[ringtones:disk-cache]", error));
    rememberPrepared(remoteUrl, clip);
    return clip;
  } catch (error) {
    console.error("[ringtones:cut]", error);
    return null;
  } finally {
    try { unlinkSync(out); } catch { /* already removed */ }
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

async function materializeFromPeak(
  remoteUrl: string,
  full: Buffer,
): Promise<{ buffer: Buffer; startSec: number }> {
  ensureMirrorDirs();
  const cached = await readPreparedClip(remoteUrl);
  if (cached) return { buffer: cached, startSec: 0 };
  const prepared = await clipJob(remoteUrl, full);
  if (!prepared) throw new Error("Не удалось подготовить рингтон. Попробуйте ещё раз.");
  return { buffer: prepared, startSec: 0 };
}

/** Legacy mp3 URLs remain valid for previously saved ringtone preferences. */
export function isAllowedRingtoneUrl(raw: string) {
  if (youtubeVideoId(raw)) return true;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== "443")) return false;
    if (!["zvukogram.com", "www.zvukogram.com"].includes(parsed.hostname)) return false;
    return /^\/mp3\/cats\/[^?]*\.mp3$/i.test(parsed.pathname) &&
      !parsed.pathname.includes("..") && !/%2e|%5c/i.test(parsed.pathname);
  } catch { return false; }
}

function normalizeRemoteUrl(raw: string) {
  const videoId = youtubeVideoId(raw);
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  if (!isAllowedRingtoneUrl(raw)) return null;
  const parsed = new URL(raw);
  parsed.hostname = "zvukogram.com";
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

async function refreshFromRemote(page: number, query: string, key: string) {
  if (activeSearches >= 4 || !rateLimit("ringtone-search-global", 120, 60_000)) throw new RingtoneBusyError();
  activeSearches++;
  try {
    const data = await searchYoutubeRingtones(page, query);
    rememberPage(key, data);
    await writePageMirror(key, data.items, data.pages);
    return data;
  } finally { activeSearches--; }
}

function rememberPage(key: string, data: { items: RingtoneItem[]; pages: number }) {
  if (pageCache.size >= 100) pageCache.delete(pageCache.keys().next().value!);
  pageCache.set(key, { expires: Date.now() + CACHE_TTL_MS, ...data });
}

export async function listRingtones(page = 1, query = "") {
  const safePage = Math.max(1, Math.min(MAX_PAGE, Math.floor(page) || 1));
  const q = normalizeRingtoneQuery(query);
  if (q.length < 2) return { items: [], page: 1, pages: 1, source: "YouTube" };
  const key = `youtube-${audioKey(q)}-${safePage}`;
  const cached = pageCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return { items: cached.items, page: safePage, pages: cached.pages, source: "YouTube" };
  }
  const mirrored = await readPageMirror(key);
  if (mirrored) {
    rememberPage(key, mirrored);
    return { ...mirrored, page: safePage, source: "YouTube" };
  }
  const fresh = await refreshFromRemote(safePage, q, key);
  return { ...fresh, page: safePage, source: "YouTube" };
}

async function downloadRemoteAudio(target: string) {
  if (!rateLimit("ringtone-download-global", 60, 60 * 60_000)) throw new RingtoneBusyError();
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (compatible; PulseChat/1.0; +https://localhost)",
    Accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.5",
    Referer: "https://zvukogram.com/",
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

async function youtubeSource(target: string, persist = true): Promise<Buffer> {
  const existing = sourceJobs.get(target);
  if (existing) return existing;
  const job = (async () => {
    const cached = await readLocalAudio(target);
    if (cached) return cached;
    if (!rateLimit("ringtone-download-global", 60, 60 * 60_000)) throw new RingtoneBusyError();
    const buffer = await downloadYoutubeRingtone(target);
    if (persist) await writeLocalAudio(target, buffer);
    return buffer;
  })().finally(() => sourceJobs.delete(target));
  sourceJobs.set(target, job);
  return job;
}

export async function ringtoneSource(remoteUrl: string) {
  const id = youtubeVideoId(remoteUrl);
  if (!id) throw new Error("Некорректная ссылка YouTube");
  const buffer = await youtubeSource(`https://www.youtube.com/watch?v=${id}`);
  const contentType = buffer.toString("ascii", 4, 8) === "ftyp" ? "audio/mp4"
    : buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? "audio/webm"
    : buffer.toString("ascii", 0, 4) === "OggS" ? "audio/ogg" : "audio/mpeg";
  return { buffer, contentType };
}

async function proxyRingtoneAudioOnce(target: string) {
  const clip = await readPreparedClip(target);
  if (clip) return { buffer: clip, startSec: 0, contentType: "audio/mpeg" };
  if (youtubeVideoId(target)) {
    const full = await youtubeSource(target, false);
    const prepared = await clipJob(target, full);
    if (!prepared) throw new Error("Не удалось подготовить рингтон. Попробуйте ещё раз.");
    return { buffer: prepared, startSec: 0, contentType: "audio/mpeg" };
  }
  const local = await readLocalAudio(target);
  if (local) {
    const prepared = await materializeFromPeak(target, local);
    return { ...prepared, contentType: "audio/mpeg" };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { buffer, contentType } = await downloadRemoteAudio(target);
      await writeLocalAudio(target, buffer);
      const prepared = await materializeFromPeak(target, buffer);
      return { ...prepared, contentType };
    } catch (error) {
      if (error instanceof RingtoneBusyError) throw error;
      lastError = error;
      const again = await readLocalAudio(target);
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
  const job = withAudioSlot(() => proxyRingtoneAudioOnce(target)).finally(() => {
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
  onPreferenceChanged: (userId: string) => void = () => {},
) {
  if (await handleRingtonePreference(req, res, onPreferenceChanged, isAllowedRingtoneUrl)) return;
  const parsed = parseUrl(req.url || "", true);
  const pathname = parsed.pathname || "";
  const ip = clientAddress(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "x-pulse-token");

  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const auth = restoreSession(String(req.headers["x-pulse-token"] || ""));
  if (!auth.ok) {
    json(res, 401, { ok: false, error: "Сначала войдите в аккаунт" });
    return;
  }
  const userId = auth.account.userId;
  const limited = (kind: string, perMinute: number, perHour?: number) => {
    const limits: Array<[string, number, number]> = [
      [`ringtone-${kind}:${userId}`, perMinute, 60_000],
      [`ringtone-${kind}-ip:${ip}`, perMinute * 3, 60_000],
    ];
    if (perHour !== undefined) limits.push([`ringtone-${kind}-hour:${userId}`, perHour, 60 * 60_000]);
    for (const [key, limit, window] of limits) {
      if (!rateLimit(key, limit, window)) {
        res.setHeader("Retry-After", String(rateLimitRetrySeconds(key)));
        return true;
      }
    }
    return false;
  };
  const rejectLimit = () => {
    json(res, 429, { ok: false, error: "Слишком много запросов рингтонов. Попробуйте позже" });
  };

  try {
    if (pathname === "/api/ringtones" || pathname === "/api/ringtones/") {
      if (limited("catalog", 30)) { rejectLimit(); return; }
      const page = Number(parsed.query.page || 1);
      const query = String(parsed.query.q || "");
      const data = await listRingtones(page, query);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true, ...data }));
      return;
    }

    if (pathname === "/api/ringtones/source") {
      if (limited("source", 6, 30)) { rejectLimit(); return; }
      const remote = String(parsed.query.u || "");
      if (!youtubeVideoId(remote)) {
        json(res, 400, { ok: false, error: "Некорректная ссылка YouTube" });
        return;
      }
      if (activeSources >= 2) throw new RingtoneBusyError();
      activeSources++;
      let source: Awaited<ReturnType<typeof ringtoneSource>>;
      try { source = await ringtoneSource(remote); }
      finally { activeSources--; }
      const { buffer, contentType } = source;
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : buffer);
      return;
    }

    if (pathname === "/api/ringtones/audio") {
      const remote = String(parsed.query.u || "");
      if (!normalizeRemoteUrl(remote)) { json(res, 400, { ok: false, error: "Недопустимый адрес рингтона" }); return; }
      if (limited("audio", 30, 120)) { rejectLimit(); return; }
      const { buffer, contentType, startSec } =
        await proxyRingtoneAudio(remote);
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
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
    if (error instanceof RingtoneBusyError) {
      res.setHeader("Retry-After", "60");
      json(res, 503, { ok: false, error: error.message });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Ошибка каталога рингтонов";
    json(res, 502, { ok: false, error: message });
  }
}
