const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  // Derive every size from the full-resolution smooth artwork, never from a
  // previously downscaled 192px web favicon.
  const source = path.join(__dirname, 'assets/icon-source.png');
  const metadata = await sharp(source).metadata();
  if (metadata.width < 1024 || metadata.height < 1024 || !metadata.hasAlpha) throw new Error('Icon source must be a transparent image of at least 1024px.');
  await sharp(source).resize(1024, 1024).png().toFile(path.join(__dirname, 'assets/icon.png'));
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const images = [];
  for (const size of sizes) {
    if (size === 256) {
      images.push(await sharp(source).resize(size, size).png().toBuffer());
      continue;
    }
    // Small Windows shell icons need ordinary 32-bit DIB entries. A lone
    // 256px PNG entry did not yield icons for Explorer or ExtractIconEx.
    const rgba = await sharp(source).resize(size, size).ensureAlpha().raw().toBuffer();
    const maskStride = Math.ceil(size / 32) * 4;
    const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    dib.writeUInt32LE(size * size * 4, 20);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = 40 + ((size - 1 - y) * size + x) * 4;
      dib[to] = rgba[from + 2]; dib[to + 1] = rgba[from + 1];
      dib[to + 2] = rgba[from]; dib[to + 3] = rgba[from + 3];
      if (rgba[from + 3] === 0) dib[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)] |= 1 << (7 - x % 8);
    }
    images.push(dib);
  }
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    directory[entry] = sizes[index] % 256; directory[entry + 1] = sizes[index] % 256;
    directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  await fs.writeFile(path.join(__dirname, 'assets/icon.ico'), Buffer.concat([directory, ...images]));
  console.log('Prepared smooth Maiko artwork (1024px) and Windows icons: 16–256 px, including HiDPI sizes.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
