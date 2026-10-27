import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type Request = { name: string; version: string; width: number; source: () => Promise<string> };
export type Preview = { filename: string; size: number };

/** Small, transparent WebP frames. Originals and signed access remain separate. */
export function createMediaPreviewService(directory: string, options: { concurrency?: number; maxPending?: number } = {}) {
  const jobs = new Map<string, Promise<Preview | null>>();
  const failures = new Map<string, number>();
  const queue: (() => void)[] = [];
  const concurrency = options.concurrency ?? 2;
  const maxPending = options.maxPending ?? 32;
  let active = 0;
  let nextSweep = 0;

  async function sweep() {
    if (Date.now() < nextSweep) return;
    nextSweep = Date.now() + 60_000;
    const entries = await readdir(directory);
    const files = (await Promise.all(entries.filter(name => /^[\w.-]+\.preview-[a-f0-9]{16}\.w\d+\.webp$/.test(name))
      .map(async name => {
        const filename = path.join(directory, name);
        const info = await stat(filename).catch(() => null);
        return info ? { filename, size: info.size, time: info.mtimeMs } : null;
      }))).filter(file => file !== null).sort((a, b) => b.time - a.time);
    let bytes = 0;
    for (const [index, file] of files.entries()) {
      bytes += file.size;
      if (index >= 2000 || bytes > 256 * 1024 * 1024) await unlink(file.filename).catch(() => {});
    }
  }

  async function generate(request: Request, filename: string): Promise<Preview | null> {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      const source = await request.source();
      const ok = await new Promise<boolean>(resolve => {
        const child = spawn("ffmpeg", ["-v", "error", "-y", "-threads", "1",
          ...(/^https:\/\//.test(source) ? ["-rw_timeout", "10000000"] : []),
          "-i", source, "-vf", `scale=w='min(${request.width},iw)':h=-2`,
          "-frames:v", "1", "-c:v", "libwebp", "-quality", "76", "-compression_level", "3",
          "-threads", "1", "-f", "webp", temporary],
        { stdio: "ignore", windowsHide: true });
        const timer = setTimeout(() => { child.kill(); }, 15_000);
        child.once("error", () => { clearTimeout(timer); resolve(false); });
        child.once("close", code => { clearTimeout(timer); resolve(code === 0); });
      });
      if (!ok) throw new Error("Preview generation failed");
      const info = await stat(temporary);
      if (!info.size || info.size > 4 * 1024 * 1024) throw new Error("Invalid preview size");
      await rename(temporary, filename);
      void sweep().catch(() => {});
      return { filename, size: info.size };
    } catch {
      await unlink(temporary).catch(() => {});
      while (failures.size >= 256) failures.delete(failures.keys().next().value!);
      failures.set(filename, Date.now() + 30_000);
      return null;
    }
  }

  return {
    async get(request: Request): Promise<Preview | null> {
      if (!request.name || /[/\\:\u0000-\u001f]/.test(request.name) || ![320, 430, 860, 1080].includes(request.width)) return null;
      const version = createHash("sha256").update(request.version).digest("hex").slice(0, 16);
      const resource = createHash("sha256").update(request.name).digest("hex").slice(0, 24);
      const filename = path.join(directory, `${resource}.preview-${version}.w${request.width}.webp`);
      const existing = jobs.get(filename);
      if (existing) return existing;
      const info = await stat(filename).catch(() => null);
      if (info?.isFile() && info.size) return { filename, size: info.size };
      // A second request can have completed stat() while the first queued work.
      if (jobs.has(filename)) return jobs.get(filename)!;
      if ((failures.get(filename) ?? 0) > Date.now() || jobs.size >= maxPending) return null;
      const job = new Promise<Preview | null>(resolve => {
        const start = () => {
          active++;
          void generate(request, filename).then(resolve).finally(() => {
            active--;
            jobs.delete(filename);
            queue.shift()?.();
          });
        };
        // Defer work until the job is registered, even for synchronous failures.
        if (active < concurrency) { active++; queueMicrotask(() => { active--; start(); }); }
        else queue.push(start);
      });
      jobs.set(filename, job);
      return job;
    },
  };
}

/** Stop waiting without cancelling shared work for other clients. */
export async function previewWithin(job: Promise<Preview | null>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}
