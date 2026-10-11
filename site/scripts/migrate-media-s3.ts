import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileSha256, headObject, putObjectFile, readObject, s3Client, s3Enabled } from "../src/server/objectStorage";
import { looksLikeImage, mimeFromName } from "../src/server/uploads";

/** Safe to rerun: never deletes sources or overwrites a conflicting object. */
async function main() {
  if (!s3Enabled) throw new Error("Configure S3_CONFIG_FILE or S3_* first");
  const verifyOnly = process.argv.includes("--verify-only");
  const skipVerifiedDownloads = process.argv.includes("--skip-verified-downloads");
  const source = path.resolve(process.env.MEDIA_SOURCE_DIR || process.cwd());
  const roots = [
    { dir: path.join(source, "uploads"), prefix: "uploads" },
    { dir: path.join(source, "data", "ringtones", "audio"), prefix: "ringtones/audio" },
  ];
  let count = 0;
  let bytes = 0;
  let copied = 0;
  async function visit(dir: string, prefix: string) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const filename = path.join(dir, entry.name);
      const key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { await visit(filename, key); continue; }
      if (!entry.isFile() || /\.(tmp|browser\.mp4)$/.test(entry.name)) continue;
      const before = await stat(filename);
      const sha256 = await fileSha256(filename);
      const existing = await headObject(key);
      if (!existing) {
        if (verifyOnly) throw new Error(`Missing object: ${key}`);
        await putObjectFile(key, filename, mimeFromName(entry.name), {
          image: String(looksLikeImage(filename)),
          "source-mtime": String(before.mtimeMs),
        });
        copied++;
      } else if (existing.ContentLength !== before.size || (existing.Metadata?.sha256 && existing.Metadata.sha256 !== sha256)) {
        throw new Error(`Conflicting object, left untouched: ${key}`);
      }
      // Cutover can skip repeat downloads only after the full pass was verified.
      let received = before.size;
      if (!skipVerifiedDownloads || !existing || existing.Metadata?.sha256 !== sha256) {
        const { body } = await readObject(key);
        const hash = createHash("sha256");
        received = 0;
        for await (const chunk of body) { hash.update(chunk); received += chunk.length; }
        if (received !== before.size || hash.digest("hex") !== sha256) throw new Error(`Checksum mismatch: ${key}`);
      }
      const after = await stat(filename);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`Source changed during migration: ${key}`);
      count++;
      bytes += received;
      console.log(JSON.stringify({ verified: count, key, bytes: received, copied }));
    }
  }
  for (const root of roots) await visit(root.dir, root.prefix);
  console.log(JSON.stringify({ ok: true, verified: count, copied, bytes, skippedRepeatDownloads: skipVerifiedDownloads, sourceFilesKept: true }));
}

main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; })
  .finally(() => s3Client?.destroy());
