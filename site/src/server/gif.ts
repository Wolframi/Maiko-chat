import { fetchGiphyApi } from "../lib/giphyFetch";
import { giphyApiKey } from "../lib/giphyKey";
import { pickGiphyPreviewUrl, pickGiphySendAsset } from "../lib/giphyMedia";
import { rateLimit } from "./rateLimit";

type Image = NonNullable<Parameters<typeof pickGiphySendAsset>[0]> & {
  original?: { width?: string; height?: string; url?: string; webp?: string };
  fixed_width?: { width?: string; height?: string };
};
type ProviderResponse = { data?: { id?: string; title?: string; images?: Image }[]; pagination?: { total_count?: number } };
type Entry = { body: string; expiresAt: number };

export function gifParameters(url: string) {
  const params = new URL(url, "http://localhost").searchParams;
  const query = (params.get("q") || "").trim();
  const offset = Number(params.get("pos") || 0);
  const limit = Number(params.get("limit") || 20);
  if (query.length > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return null;
  return { query: query.length >= 2 ? query : "", offset, limit };
}

async function readProvider(response: Response) {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("GIF response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderResponse;
  } finally { await reader.cancel().catch(() => {}); }
}

export function createGifService(fetcher = fetchGiphyApi, keyReader = giphyApiKey) {
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<string>>();
  return async (url: string): Promise<Response> => {
    const headers = { "Cache-Control": "private, no-store", Vary: "x-pulse-token" };
    const args = gifParameters(url);
    if (!args) return Response.json({ error: "Invalid GIF query" }, { status: 400, headers });
    const { query, offset, limit } = args;
    const key = JSON.stringify([query.toLowerCase(), offset, limit]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return new Response(cached.body, { headers: { ...headers, "Content-Type": "application/json" } });
    cache.delete(key);
    let job = pending.get(key);
    if (!job) {
      if (pending.size >= 4 || !rateLimit("gif-upstream", 60, 60_000)) {
        return Response.json({ error: "Too many GIF requests" }, { status: 429, headers: { ...headers, "Retry-After": "10" } });
      }
      job = (async () => {
        const apiKey = keyReader();
        if (!apiKey) throw new Error("GIF provider is not configured");
        const params = new URLSearchParams({ api_key: apiKey, limit: String(limit), offset: String(offset), rating: "pg-13", lang: "ru" });
        if (query) params.set("q", query);
        const response = await fetcher(`https://api.giphy.com/v1/gifs/${query ? "search" : "trending"}?${params}`, {
          headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error("GIF provider unavailable"); }
        const data = await readProvider(response);
        const results = (Array.isArray(data.data) ? data.data : []).slice(0, limit).flatMap(item => {
          const send = pickGiphySendAsset(item.images);
          if (!send) return [];
          return [{ id: String(item.id || "").slice(0, 100), title: String(item.title || "").slice(0, 200),
            url: send.url, preview: pickGiphyPreviewUrl(item.images) || send.url,
            width: Number(item.images?.original?.width) || 320, height: Number(item.images?.original?.height) || 180,
            size: send.size, mime: send.mime }];
        });
        const body = JSON.stringify({ results, next: results.length && offset + limit <= 1000 ? String(offset + limit) : "", total: data.pagination?.total_count || results.length });
        // Hard limits even when none of the entries have expired.
        if (Buffer.byteLength(body) <= 64 * 1024) {
          while (cache.size >= 128) cache.delete(cache.keys().next().value!);
          cache.set(key, { body, expiresAt: Date.now() + (query ? 15 : 30) * 60_000 });
        }
        return body;
      })().finally(() => pending.delete(key));
      pending.set(key, job);
    }
    try { return new Response(await job, { headers: { ...headers, "Content-Type": "application/json" } }); }
    catch { return Response.json({ results: [], next: "", error: "GIF service unavailable" }, { status: 503, headers }); }
  };
}

export const getGifs = createGifService();
