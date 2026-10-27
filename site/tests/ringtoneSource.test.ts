import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("trimming requires a session and returns the full source instead of the prepared clip", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "maiko-ringtone-source-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("maiko-ringtone-source-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const require = createRequire(import.meta.url);
  const loader = require.resolve("tsx/cjs");
  const authPath = fileURLToPath(new URL("../src/server/auth.ts", import.meta.url));
  const handlerPath = fileURLToPath(new URL("../src/server/ringtones.ts", import.meta.url));
  execFileSync(process.execPath, ["--require", loader, "-e", `
    process.env.MEDIA_STORAGE = 'local';
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { createHash } = require('node:crypto');
    const { createServer } = require('node:http');
    fs.mkdirSync('data', { recursive: true });
    if (!fs.existsSync('data/registration-invites.json')) fs.writeFileSync('data/registration-invites.json', JSON.stringify({ required: false, adminUserId: null, secret: 'a'.repeat(64) }));
    const auth = require(${JSON.stringify(authPath)});
    const account = auth.registerUser('source-user', 'Password123!').account;
    const remote = 'https://www.youtube.com/watch?v=I48Yz36NoC8';
    const key = createHash('sha1').update(remote).digest('hex');
    const original = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(100)]);
    fs.mkdirSync('data/ringtones/audio', { recursive: true });
    fs.writeFileSync('data/ringtones/audio/' + key + '.mp3', original);
    fs.writeFileSync('data/ringtones/audio/' + key + '.hook-v3.mp3', Buffer.alloc(2000, 1));
    const currentClip = Buffer.alloc(2000, 2);
    fs.writeFileSync('data/ringtones/audio/' + key + '.hook-v4.mp3', currentClip);
    const { handleRingtones } = require(${JSON.stringify(handlerPath)});
    const server = createServer((req, res) => { void handleRingtones(req, res); });
    (async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port + '/api/ringtones/source?u=';
      const headers = { 'x-pulse-token': account.token };
      try {
        assert.equal((await fetch(base + encodeURIComponent(remote))).status, 401);
        assert.equal((await fetch(base + encodeURIComponent('https://127.0.0.1/private'), { headers })).status, 400);
        const response = await fetch(base + encodeURIComponent(remote), { headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'audio/mp4');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
        const head = await fetch(base + encodeURIComponent(remote), { headers, method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(Number(head.headers.get('content-length')), original.length);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const audioUrl = base.replace('/source?u=', '/audio?u=') + encodeURIComponent(remote);
        for (const url of [audioUrl, base.split('/source?u=')[0] + '?q=test']) {
          for (const method of ['GET', 'HEAD']) {
            const denied = await fetch(url, { method });
            assert.equal(denied.status, 401);
            assert.equal(denied.headers.get('cache-control'), 'private, no-store');
            assert.equal((await fetch(url, { method, headers: { 'x-pulse-token': 'invalid' } })).status, 401);
          }
        }
        const clip = await fetch(audioUrl, { headers });
        assert.equal(clip.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(Buffer.from(await clip.arrayBuffer()), currentClip);
        const clipHead = await fetch(audioUrl, { headers, method: 'HEAD' });
        assert.equal(clipHead.status, 200);
        assert.equal((await clipHead.arrayBuffer()).byteLength, 0);
        fs.unlinkSync('data/ringtones/audio/' + key + '.hook-v4.mp3');
        assert.deepEqual(Buffer.from(await (await fetch(audioUrl, { headers })).arrayBuffer()), currentClip);
        const catalog = base.split('/source?u=')[0] + '?q=';
        const empty = await (await fetch(catalog, { headers })).json();
        assert.deepEqual(empty.items, []);
        assert.equal(empty.pages, 1);
        for (let i = 0; i < 29; i++) assert.equal((await fetch(catalog, { headers })).status, 200);
        const limited = await fetch(catalog, { headers });
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get('retry-after')) > 0);
        auth.logoutToken(account.token);
        assert.equal((await fetch(audioUrl, { headers })).status, 401);
      } finally { await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 60_000 });
});
