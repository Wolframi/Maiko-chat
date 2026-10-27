const fs = require('node:fs/promises');
const path = require('node:path');
const { publicAsset, nextAsset } = require('./asset-manifest.cjs');
const config = require('./config.json');

const project = path.resolve(__dirname, '../site');
const destination = path.join(__dirname, 'bundled-assets');
const staging = path.join(__dirname, 'bundled-assets.pending');
const manifest = {};

async function save(urlPath, content) {
  const relative = urlPath.slice(1);
  const target = path.resolve(staging, relative);
  if (!target.startsWith(staging + path.sep) || urlPath.includes('..')) throw new Error('Invalid asset path');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  manifest[urlPath] = relative;
}
async function copyDirectory(directory, prefix, accept) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const source = path.join(directory, entry.name);
    const urlPath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await copyDirectory(source, urlPath, accept);
    else if (entry.isFile() && accept(urlPath)) await save(urlPath, await fs.readFile(source));
  }
}

// Next's content-addressed chunks are safe to reuse only at the exact same URL.
// Also collect the currently deployed frontend so the EXE has its CSS/JS/fonts.
async function collectDeployment() {
  const origin = new URL(config.url).origin;
  const queue = new Set();
  function references(text, base) {
    for (const match of text.matchAll(/(?:\/_next\/|\.\.\/|\.?\/)?static\/(?:chunks|media)\/[a-zA-Z0-9_./%-]+\.(?:js|css|woff2?|png|jpg|svg)|(?:\/_next\/static\/[^\s"'<>\\]+)|\.\.\/media\/[a-zA-Z0-9_.%-]+/g)) {
      let value = match[0];
      if (value.startsWith('static/')) value = '/_next/' + value;
      const url = new URL(value, base);
      if (url.origin === origin && nextAsset(url.pathname)) queue.add(url.pathname);
    }
  }
  const response = await fetch(config.url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || new URL(response.url).origin !== origin) throw new Error('Frontend download failed');
  references(await response.text(), config.url);
  const visited = new Set();
  while (queue.size) {
    const batch = [...queue].filter((item) => !visited.has(item)).slice(0, 8);
    if (!batch.length) break;
    await Promise.all(batch.map(async (urlPath) => {
      visited.add(urlPath);
      if (visited.size > 500) throw new Error('Too many frontend assets');
      const url = new URL(urlPath, origin).href;
      const resource = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resource.ok || new URL(resource.url).origin !== origin) throw new Error(`Missing frontend asset: ${urlPath}`);
      const buffer = Buffer.from(await resource.arrayBuffer());
      await save(urlPath, buffer);
      if (/\.(js|css)$/.test(urlPath)) references(buffer.toString('utf8'), url);
    }));
  }
  if (!visited.size) throw new Error('No deployed frontend assets were found');
  console.log(`Bundled ${visited.size} deployed frontend assets.`);
}

// Explicit offline rebuild from a previously verified package. Only hashed
// frontend files are reused; public media is always copied from this checkout.
function cachedFrontendArgument() {
  const index = process.argv.indexOf('--cached-frontend');
  if (index < 0) return null;
  if (!process.argv[index + 1]) throw new Error('Missing previous app.asar path');
  return path.resolve(process.argv[index + 1]);
}
async function collectCachedDeployment(archive) {
  const asar = require('@electron/asar');
  const previousConfig = JSON.parse(asar.extractFile(archive, 'config.json').toString('utf8'));
  if (new URL(previousConfig.url).origin !== new URL(config.url).origin) throw new Error('Cached frontend belongs to another server');
  const previousManifest = JSON.parse(asar.extractFile(archive, path.join('bundled-assets', 'manifest.json')).toString('utf8'));
  let count = 0;
  for (const [urlPath, relative] of Object.entries(previousManifest)) {
    if (!nextAsset(urlPath)) continue;
    if (relative !== urlPath.slice(1)) throw new Error('Invalid cached asset path');
    await save(urlPath, asar.extractFile(archive, path.join('bundled-assets', relative)));
    count++;
  }
  if (!count) throw new Error('No cached frontend assets found');
  console.log(`Reused ${count} exact-URL frontend assets from ${archive}.`);
}

async function main() {
  // Reuse the site's model renderer in the local startup surface, without a
  // network request or a second React application inside the Electron shell.
  await require('esbuild').build({
    entryPoints: [path.join(__dirname, 'startup-model.ts')],
    outfile: path.join(__dirname, 'ui/startup-model.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome150', minify: true,
  });
  // Ship the same viewport fixes with the EXE, including when the online site
  // still serves an older frontend. This is a local stylesheet, not server data.
  await fs.copyFile(path.join(project, 'src/app/styles/viewport.css'), path.join(__dirname, 'ui/site-layout.css'));
  // This directory is generated here and never contains project junctions/data.
  for (const [directory, name] of [[destination, 'bundled-assets'], [staging, 'bundled-assets.pending']]) {
    const expected = path.resolve(__dirname, name);
    if (directory !== expected || !directory.startsWith(__dirname + path.sep)) throw new Error('Invalid generated directory');
    const previous = await fs.lstat(directory).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (previous?.isSymbolicLink()) throw new Error('Generated asset directory must not be a link');
  }
  // Keep the usable bundle intact when deployment download fails.
  await fs.rm(staging, { recursive: true, force: true });
  await copyDirectory(path.join(project, 'public'), '', publicAsset);
  for (const name of ['icon.png', 'apple-icon.png', 'favicon.ico']) {
    const file = await fs.readFile(path.join(project, 'src', 'app', name)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (file) await save('/' + name, file);
  }
  await copyDirectory(path.join(project, '.next', 'static'), '/_next/static', nextAsset);
  const cached = cachedFrontendArgument();
  if (cached) await collectCachedDeployment(cached);
  else if (process.argv.includes('--remote')) await collectDeployment();
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.rm(destination, { recursive: true, force: true });
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(staging, destination); break; }
    catch (error) {
      // Windows may briefly retain a just-deleted directory's handle.
      if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.log(`Prepared ${Object.keys(manifest).length} local assets (animations, models, audio runtime, icons and frontend).`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
