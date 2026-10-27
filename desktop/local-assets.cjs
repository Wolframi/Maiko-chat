const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { TYPES } = require('./asset-manifest.cjs');
const { readJson } = require('./config.cjs');
const { forwardRequest } = require('./forward-request.cjs');

function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { start, end };
}

async function localResponse(request, filename) {
  const { size } = await fs.promises.stat(filename);
  const range = byteRange(request.headers.get('range'), size);
  const headers = new Headers({
    'content-type': TYPES[path.extname(filename)] || 'application/octet-stream',
    'accept-ranges': 'bytes', 'cache-control': 'no-cache',
    'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    'x-maiko-asset': 'bundled',
  });
  if (range === false) {
    headers.set('content-range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
  headers.set('content-length', String(range ? range.end - range.start + 1 : size));
  const body = request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(filename, range || undefined));
  return new Response(body, { status: range ? 206 : 200, headers });
}

function configureLocalAssets({ siteSession, trusted, log }) {
  const { net } = require('electron');
  const directory = path.join(__dirname, 'bundled-assets');
  const manifest = readJson(path.join(directory, 'manifest.json'));
  log(`Local assets available: ${Object.keys(manifest).length}`);
  const handler = async (request) => {
    const url = new URL(request.url);
    const captureModule = { '/__maiko_desktop/daw-worklet.js': 'daw-worklet.js',
      '/__maiko_desktop/automatic-audio.js': 'automatic-audio.js' }[url.pathname];
    const relative = captureModule ? null : manifest[url.pathname];
    if (captureModule && ['GET', 'HEAD'].includes(request.method) && trusted(url.href)
      && (!request.initiatorOrigin || trusted(request.initiatorOrigin))) {
      return localResponse(request, path.join(__dirname, 'ui', captureModule));
    }
    // Only app-owned, enumerated static files at the selected site's origin.
    if (relative && ['GET', 'HEAD'].includes(request.method) && trusted(url.href)
      && (!request.initiatorOrigin || trusted(request.initiatorOrigin))) {
      const filename = path.resolve(directory, relative);
      if (filename.startsWith(directory + path.sep)) {
        try { return await localResponse(request, filename); }
        catch (error) { log(`Local asset unavailable: ${url.pathname}: ${error.code || error.message}`); }
      }
    }
    // Preserve the site's session, credentials, POST bodies and remote API behavior.
    return forwardRequest(request, siteSession, net);
  };
  siteSession.protocol.handle('https', handler);
  siteSession.protocol.handle('http', handler);
}

module.exports = { byteRange, localResponse, configureLocalAssets };
