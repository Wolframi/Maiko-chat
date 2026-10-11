const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');
const run = promisify(execFile);

async function compare(file, source) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const expected = await sharp(source).resize(info.width, info.height).ensureAlpha().raw().toBuffer();
  let error = 0;
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) {
    error += Math.abs(data[i + c] * data[i + 3] / 255 - expected[i + c] * expected[i + 3] / 255);
  }
  const average = error / (info.width * info.height * 3);
  assert.ok(average < 3, `${file}: Windows retrieves the new smooth artwork, error=${average}`);
}

async function main() {
  if (process.platform !== 'win32') return;
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'test-output', `built-icons-${Date.now()}`);
  await fs.mkdir(output, { recursive: true });
  const helper = path.join(output, 'native-icons.exe');
  await run(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', '/r:System.Drawing.dll', `/out:${helper}`, path.join(__dirname, 'native-icons.cs')], { windowsHide: true });
  const source = path.join(root, 'assets/icon-source.png');
  const version = require('../package.json').version;
  const files = [path.join(root, 'release/win-unpacked/Maiko.exe'),
    path.join(root, `release/Maiko-Setup-${version}.exe`)];
  assert.ok((await sharp(source).metadata()).width >= 1024);
  assert.ok((await fs.readFile(path.join(root, 'release/win-unpacked/Maiko.ico'))).equals(await fs.readFile(path.join(root, 'assets/icon.ico'))));
  for (const file of files) {
    const prefix = path.join(output, path.basename(file));
    for (const size of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) {
      const image = `${prefix}-${size}.png`;
      await run(helper, ['extract', file, image, String(size)], { windowsHide: true });
      assert.equal((await sharp(image).metadata()).width, size);
      await compare(image, source);
    }
    await run(helper, ['shell', file, prefix], { windowsHide: true });
    await compare(`${prefix}-small.png`, source);
    await compare(`${prefix}-large.png`, source);
    console.log(`Windows icon verified: ${path.basename(file)}, 16–256px and Explorer shell retrieval.`);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
