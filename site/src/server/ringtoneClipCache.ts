import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

/** Small, disposable local copies keep S3 off the playback path after a restart. */
export class RingtoneFileCache {
  private writes: Promise<void> = Promise.resolve();

  constructor(private directory: string, private options: {
    pattern: RegExp; maxBytes: number; maxFileBytes: number; minFileBytes?: number; ttlMs?: number;
  }) {}

  private file(name: string) {
    if (path.basename(name) !== name || !this.options.pattern.test(name)) throw new Error("Invalid ringtone cache key");
    return path.join(this.directory, name);
  }

  async read(name: string): Promise<Buffer | null> {
    const file = this.file(name);
    try {
      const info = await stat(file);
      const size = info.size;
      if (Date.now() - info.mtimeMs >= (this.options.ttlMs ?? 7 * 24 * 60 * 60_000)) {
        await unlink(file); return null;
      }
      if (size <= (this.options.minFileBytes ?? 0) || size > Math.min(this.options.maxBytes, this.options.maxFileBytes)) return null;
      await utimes(file, new Date(), info.mtime);
      return await readFile(file);
    } catch { return null; }
  }

  write(name: string, buffer: Buffer): Promise<void> {
    const file = this.file(name);
    if (buffer.length <= (this.options.minFileBytes ?? 0) || buffer.length > Math.min(this.options.maxBytes, this.options.maxFileBytes)) return Promise.resolve();
    const task = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temp, buffer);
        await rename(temp, file);
      } finally { await unlink(temp).catch(() => {}); }
      const entries = await Promise.all((await readdir(this.directory))
        .filter((entry) => this.options.pattern.test(entry))
        .map(async (entry) => ({ file: this.file(entry), info: await stat(this.file(entry)).catch(() => null) })));
      const files = entries.filter((entry) => entry.info?.isFile());
      let total = files.reduce((sum, entry) => sum + entry.info!.size, 0);
      files.sort((a, b) => a.info!.atimeMs - b.info!.atimeMs);
      for (const entry of files) {
        const expired = Date.now() - entry.info!.mtimeMs >= (this.options.ttlMs ?? 7 * 24 * 60 * 60_000);
        if (total <= this.options.maxBytes && !expired) continue;
        await unlink(entry.file).catch(() => {});
        total -= entry.info!.size;
      }
    });
    this.writes = task.catch(() => {});
    return task;
  }
}

export class RingtoneClipCache extends RingtoneFileCache {
  constructor(directory: string, maxBytes = 64 * 1024 * 1024) {
    super(directory, { pattern: /^[a-f0-9]{40}\.hook-v\d+\.mp3$/, maxBytes, maxFileBytes: 2 * 1024 * 1024, minFileBytes: 1000 });
  }
}
