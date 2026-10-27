import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

// Keep the original model for native Electron rendering. The website receives
// the identical bytes through HTTP gzip, without reducing particle detail.
for (const intro of ["hiphop", "samba"]) {
  const source = new URL(`../public/models/maiko-${intro}.bin`, import.meta.url);
  const bytes = await readFile(source);
  const compressed = gzipSync(bytes, { level: 9 });
  const target = new URL(`${source.href}.gz`);
  const previous = await readFile(target).catch(() => null);
  if (!previous?.equals(compressed)) await writeFile(target, compressed);
  console.log(`Maiko ${intro}: ${bytes.length} -> ${compressed.length} bytes (lossless gzip).`);
}
