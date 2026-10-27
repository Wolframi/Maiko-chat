import { runInNewContext } from "node:vm";
import { Innertube, Platform, UniversalCache, YTNodes } from "youtubei.js";
import type { RingtoneItem } from "./ringtones";
import { ringtoneAudioPath } from "../lib/ringtoneConfig";

const MAX_VIDEO_SECONDS = 10 * 60;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const CACHE_MS = 20 * 60 * 1000;

// YouTube.js needs an evaluator for its extracted player signature functions.
// Supply only primitive inputs, with no Node globals and a bounded run time.
Platform.shim.eval = (data, env) => runInNewContext(
  `(function () { ${data.output}\n })()`,
  Object.assign(Object.create(null), env),
  { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
);

let searchClient: Promise<Innertube> | undefined;
let audioClient: Promise<Innertube> | undefined;

function client(audio = false): Promise<Innertube> {
  const existing = audio ? audioClient : searchClient;
  if (existing) return existing;
  const pending = Innertube.create({
    lang: "ru",
    location: "US",
    retrieve_player: audio,
    generate_session_locally: true,
    cache: new UniversalCache(false),
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    }),
  }).catch((error) => {
    if (audio) audioClient = undefined;
    else searchClient = undefined;
    throw error;
  });
  if (audio) audioClient = pending;
  else searchClient = pending;
  return pending;
}

export function youtubeVideoId(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["youtube.com", "www.youtube.com"].includes(url.hostname) || url.pathname !== "/watch") return null;
    const id = url.searchParams.get("v") || "";
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

type SearchPage = Awaited<ReturnType<Innertube["search"]>>;
type SearchCache = { expires: number; pages: Map<number, Promise<SearchPage>> };
const searches = new Map<string, SearchCache>();

export function normalizeRingtoneQuery(query: string) {
  return query.trim().replace(/\s+/g, " ").slice(0, 120);
}

export async function searchYoutubeRingtones(page: number, query: string) {
  const q = normalizeRingtoneQuery(query);
  if (q.length < 2) return { items: [], pages: 1 };
  let cached = searches.get(q);
  if (!cached || cached.expires <= Date.now()) {
    if (searches.size >= 30) searches.delete(searches.keys().next().value!);
    cached = { expires: Date.now() + CACHE_MS, pages: new Map() };
    searches.set(q, cached);
  }
  let result: SearchPage | undefined;
  for (let index = 1; index <= page; index++) {
    let pending = cached.pages.get(index);
    if (!pending) {
      if (index > 1 && !result?.has_continuation) return { items: [], pages: index - 1 };
      pending = index === 1
        ? client().then((yt) => yt.search(q, { type: "video" }))
        : result!.getContinuation();
      cached.pages.set(index, pending);
    }
    try { result = await pending; }
    catch (error) { cached.pages.delete(index); throw error; }
  }
  const seen = new Set<string>();
  const items: RingtoneItem[] = [];
  for (const node of result!.results) {
    if (!node.is(YTNodes.Video)) continue;
    const video = node.as(YTNodes.Video);
    if (video.is_live || video.is_upcoming || video.duration.seconds <= 0 ||
      video.duration.seconds > MAX_VIDEO_SECONDS || seen.has(video.video_id)) continue;
    const remote = `https://www.youtube.com/watch?v=${video.video_id}`;
    if (!youtubeVideoId(remote)) continue;
    seen.add(video.video_id);
    const author = video.author?.name;
    items.push({
      id: `youtube:${video.video_id}`,
      title: [video.title.toString(), author].filter(Boolean).join(" — ").slice(0, 120),
      audioUrl: remote,
      url: ringtoneAudioPath(remote),
      startSec: 0,
    });
  }
  return { items, pages: Math.min(20, page + (result!.has_continuation ? 1 : 0)) };
}

export async function downloadYoutubeRingtone(raw: string): Promise<Buffer> {
  const id = youtubeVideoId(raw);
  if (!id) throw new Error("Некорректная ссылка YouTube");
  const yt = await client(true);
  // VISIONOS avoids the rejected iOS media URLs seen on some public tracks.
  // Request fresh metadata from the alternate client once, including when the
  // download fails while reading, rather than reusing the rejected signed URL.
  for (const name of ["VISIONOS", "IOS"] as const) {
    try {
      const info = await yt.getBasicInfo(id, { client: name });
      const duration = info.basic_info.duration || 0;
      if (info.basic_info.is_live || info.basic_info.is_upcoming || duration <= 0 || duration > MAX_VIDEO_SECONDS) {
        throw new Error("Выберите запись длительностью до 10 минут");
      }
      return await readAudioStream(await info.download({ type: "audio", quality: "bestefficiency", format: "any" }));
    } catch (error) {
      const failure = error as { info?: { error_type?: string }; name?: string; message?: string } | null;
      const retryable = failure?.info?.error_type === "FETCH_FAILED" ||
        failure?.info?.error_type === "NO_STREAMING_DATA" ||
        (failure?.name === "PlayerError" && failure.message === "No valid URL to decipher") ||
        ["TypeError", "AbortError", "TimeoutError"].includes(failure?.name || "");
      if (!retryable) throw error;
      if (name === "IOS") {
        throw new Error("YouTube временно не отдаёт аудио этого трека. Попробуйте ещё раз позже", { cause: error });
      }
    }
  }
  throw new Error("Не удалось загрузить аудио YouTube");
}

async function readAudioStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("YouTube не успел загрузить аудио")), 45_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) throw new Error("Аудио больше 12 МБ");
      chunks.push(Buffer.from(value));
    }
    if (!size) throw new Error("YouTube вернул пустое аудио");
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
