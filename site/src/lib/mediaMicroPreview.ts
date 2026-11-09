import { validMicroPreview } from "./microPreview";

const completed = new Map<string, string>();
const pending = new Map<string, Promise<string | undefined>>();

/** Recover metadata omitted by a cold history/S3 preview, using the same signed access. */
export function loadMediaMicroPreview(source: string): Promise<string | undefined> {
  if (!source.startsWith("/uploads/")) return Promise.resolve(undefined);
  const url = new URL(source, window.location.origin);
  if (!url.searchParams.has("exp") || !url.searchParams.has("sig")) return Promise.resolve(undefined);
  const key = url.pathname;
  const pendingKey = `${key}:${url.searchParams.get("exp")}:${url.searchParams.get("sig")}`;
  const cached = completed.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(pendingKey);
  if (existing) return existing;
  if (pending.size >= 32) return Promise.resolve(undefined);
  for (const name of ["w", "poster", "download", "waveform", "retry"]) url.searchParams.delete(name);
  url.searchParams.set("microPreview", "1");
  const job = (async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(`${url.pathname}${url.search}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (response.status === 204 || !response.ok) { await response.body?.cancel(); return; }
      if (!response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); return; }
      const preview = validMicroPreview((await response.json()).microPreview);
      if (preview) {
        if (completed.size >= 512) completed.delete(completed.keys().next().value!);
        completed.set(key, preview);
        return preview;
      }
      if (response.status !== 202) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  })().catch(() => undefined).finally(() => pending.delete(pendingKey));
  pending.set(pendingKey, job);
  return job;
}
