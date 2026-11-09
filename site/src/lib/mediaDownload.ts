import { mediaResourceKey } from "./files";

export type MediaDownload = { url?: string; received: number; total?: number; error?: boolean };
type Entry = { key: string; state: MediaDownload; listeners: Set<(state: MediaDownload) => void>;
  controller: AbortController; frame: number; bytes: number; touched: number; done: boolean };

const entries = new Map<string, Entry>();
const MAX_IDLE_BYTES = 48 * 1024 * 1024;

function remove(entry: Entry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  cancelAnimationFrame(entry.frame);
  entry.controller.abort();
  if (entry.state.url?.startsWith("blob:")) URL.revokeObjectURL(entry.state.url);
}

function sweep() {
  let bytes = 0;
  let count = 0;
  for (const entry of [...entries.values()].sort((a, b) => b.touched - a.touched)) {
    if (entry.listeners.size || !entry.done) continue;
    if (entry.bytes > 8 * 1024 * 1024 || Date.now() - entry.touched > 120_000) { remove(entry); continue; }
    bytes += entry.bytes;
    if (bytes > MAX_IDLE_BYTES || ++count > 128) remove(entry);
  }
}

/** One streamed request supplies both real byte progress and the displayed Blob. */
export function subscribeMediaDownload(source: string, listener: (state: MediaDownload) => void) {
  if (/^(blob:|data:)/.test(source)) {
    listener({ url: source, received: 0 });
    return () => {};
  }
  let account = "";
  try { account = localStorage.getItem("pulse-chat-token") || ""; } catch { /* private browsing */ }
  const key = `${account}\0${mediaResourceKey(source)}`;
  let entry = entries.get(key);
  if (entry?.state.error) entry = undefined;
  if (!entry) {
    entry = { key, state: { received: 0 }, listeners: new Set(), controller: new AbortController(),
      frame: 0, bytes: 0, touched: Date.now(), done: false };
    entries.set(key, entry);
    const job = entry;
    const emit = () => { job.frame = 0; for (const notify of job.listeners) notify(job.state); };
    void (async () => {
      const response = await fetch(source, { signal: job.controller.signal, referrerPolicy: "no-referrer" });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Media download failed"); }
      const length = Number(response.headers.get("content-length"));
      const encoding = response.headers.get("content-encoding");
      const total = Number.isFinite(length) && length > 0 && (!encoding || encoding === "identity") ? length : undefined;
      job.state = { received: 0, total };
      emit();
      let received = 0;
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          job.state = { received, total: total && received <= total ? total : undefined };
          if (!job.frame) job.frame = requestAnimationFrame(emit);
          controller.enqueue(chunk);
        },
      }));
      const blob = await new Response(stream, { headers: { "Content-Type": response.headers.get("content-type") || "application/octet-stream" } }).blob();
      if (job.controller.signal.aborted) return;
      job.bytes = blob.size;
      job.done = true;
      job.state = { url: URL.createObjectURL(blob), received: received || blob.size, total: received || blob.size };
      cancelAnimationFrame(job.frame);
      emit();
      sweep();
    })().catch(() => {
      if (job.controller.signal.aborted) return;
      job.done = true;
      job.state = { received: job.state.received, error: true };
      cancelAnimationFrame(job.frame);
      emit();
    });
  }
  const resource = entry;
  resource.listeners.add(listener);
  resource.touched = Date.now();
  listener(resource.state);
  sweep();
  return () => {
    resource.listeners.delete(listener);
    resource.touched = Date.now();
    // StrictMode immediately re-subscribes; a real unmount cancels its transfer.
    queueMicrotask(() => {
      if (resource.listeners.size) return;
      if (!resource.done || resource.state.error) remove(resource);
      else sweep();
    });
  };
}
