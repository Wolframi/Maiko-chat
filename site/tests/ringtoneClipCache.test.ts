import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { RingtoneClipCache, RingtoneFileCache } from "../src/server/ringtoneClipCache";

test("clip cache survives restarts, limits disk use and preserves source audio", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "maiko-clip-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = `${"a".repeat(40)}.hook-v4.mp3`;
  const second = `${"b".repeat(40)}.hook-v4.mp3`;
  const source = `${"a".repeat(40)}.mp3`;
  const clip = Buffer.alloc(2000, 7);
  const cache = new RingtoneClipCache(directory, 3000);
  assert.equal(await cache.read(first), null);
  await writeFile(path.join(directory, source), "source audio");
  await cache.write(first, clip);
  assert.deepEqual(await new RingtoneClipCache(directory).read(first), clip);
  await utimes(path.join(directory, first), 1, 1);
  await cache.write(second, clip);
  assert.equal(await cache.read(first), null);
  assert.deepEqual(await cache.read(second), clip);
  assert.equal(await readFile(path.join(directory, source), "utf8"), "source audio");
  assert.ok(!(await readdir(directory)).some((file) => file.endsWith(".tmp")));
  await assert.rejects(cache.read("../source.mp3"), /Invalid/);
  await cache.write(first, Buffer.alloc(5000));
  assert.equal(await cache.read(first), null);
});

test("source cache evicts least recently used files and expires entries without deleting unrelated data", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "maiko-source-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new RingtoneFileCache(directory, { pattern: /^[a-c]\.mp3$/, maxBytes: 4000, maxFileBytes: 2000, ttlMs: 60_000 });
  await writeFile(path.join(directory, "unrelated.txt"), "keep");
  await cache.write("a.mp3", Buffer.alloc(2000, 1));
  await cache.write("b.mp3", Buffer.alloc(2000, 2));
  await utimes(path.join(directory, "b.mp3"), new Date(Date.now() - 10_000), new Date());
  await cache.read("a.mp3");
  await cache.write("c.mp3", Buffer.alloc(2000, 3));
  assert.equal(await cache.read("b.mp3"), null);
  assert.ok(await cache.read("a.mp3"));
  await utimes(path.join(directory, "a.mp3"), 1, 1);
  assert.equal(await cache.read("a.mp3"), null);
  assert.equal(await readFile(path.join(directory, "unrelated.txt"), "utf8"), "keep");
});
