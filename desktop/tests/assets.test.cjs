const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { byteRange, localResponse } = require('../local-assets.cjs');
const { nextAsset, publicAsset } = require('../asset-manifest.cjs');

test('video byte ranges support seeking, suffixes, open ends and reject unsatisfiable ranges', () => {
  assert.deepEqual(byteRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(byteRange('bytes=100-', 1000), { start: 100, end: 999 });
  assert.deepEqual(byteRange('bytes=-50', 1000), { start: 950, end: 999 });
  assert.deepEqual(byteRange('bytes=900-9999', 1000), { start: 900, end: 999 });
  for (const range of ['bytes=1000-', 'bytes=50-10', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'bogus']) assert.equal(byteRange(range, 1000), false);
});

test('local video returns the correct MIME, byte range, content and HEAD metadata', async () => {
  const file = path.resolve(__dirname, '../../site/public/maiko/maiko-intro-v11.webm');
  const url = 'https://maiko.example/maiko/maiko-intro-v11.webm';
  const expected = (await fs.readFile(file)).subarray(32, 96);
  const response = await localResponse(new Request(url, { headers: { range: 'bytes=32-95' } }), file);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/webm');
  assert.equal(response.headers.get('content-length'), '64');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  const head = await localResponse(new Request(url, { method: 'HEAD' }), file);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), String((await fs.stat(file)).size));
});

test('bundling excludes service workers, maps and dynamic routes', () => {
  assert.equal(publicAsset('sw.js'), false);
  assert.equal(publicAsset('/sw.js'), false);
  assert.equal(publicAsset('/audio/dtln-0.1.1/LICENSE'), true);
  assert.equal(publicAsset('models/README.md'), false);
  assert.equal(publicAsset('audio/dtln-0.1.1/worker.js'), true);
  assert.equal(nextAsset('/_next/static/chunks/abc123.js'), true);
  for (const url of ['/api/health', '/uploads/photo.png', '/_next/static/../secret.js', '/_next/static/chunks/a.js.map']) assert.equal(nextAsset(url), false);
});
