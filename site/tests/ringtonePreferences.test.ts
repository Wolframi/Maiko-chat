import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const loader = require.resolve("tsx/cjs");
const authPath = fileURLToPath(new URL("../src/server/auth.ts", import.meta.url));
const handlerPath = fileURLToPath(new URL("../src/server/ringtonePreferences.ts", import.meta.url));

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "maiko-ringtone-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("maiko-ringtone-test-"));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function run(directory: string, body: string) {
  execFileSync(process.execPath, ["--require", loader, "-e", `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { createServer } = require('node:http');
    fs.mkdirSync('data', { recursive: true });
    if (!fs.existsSync('data/registration-invites.json')) fs.writeFileSync('data/registration-invites.json', JSON.stringify({ required: false, adminUserId: null, secret: 'a'.repeat(64) }));
    const auth = require(${JSON.stringify(authPath)});
    const first = auth.registerUser('ringtone-user', 'Password123!').account || auth.loginUser('ringtone-user', 'Password123!').account;
    const second = auth.loginUser('ringtone-user', 'Password123!').account;
    const other = auth.registerUser('other-user', 'Password123!').account || auth.loginUser('other-user', 'Password123!').account;
    fs.mkdirSync('uploads', { recursive: true });
    const clip = '/uploads/12345678-1234-1234-1234-123456789abc.wav';
    const source = '/uploads/22345678-1234-1234-1234-123456789abc.wav';
    const forbidden = '/uploads/32345678-1234-1234-1234-123456789abc.wav';
    for (const url of [clip, source, forbidden]) fs.writeFileSync('.' + url, Buffer.alloc(44));
    fs.writeFileSync('data/upload-owners.json', JSON.stringify({ [clip]: first.userId, [source]: first.userId, [forbidden]: other.userId }));
    const { handleRingtonePreference } = require(${JSON.stringify(handlerPath)});
    const notices = [];
    const server = createServer((req, res) => { void handleRingtonePreference(req, res, id => notices.push(id), url => {
      const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'zvukogram.com' && parsed.pathname.startsWith('/mp3/cats/');
    }); });
    (async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + server.address().port + '/api/ringtones/preference';
      const read = async token => { const r = await fetch(url, { headers: { 'x-pulse-token': token } }); assert.equal(r.status, 200); return (await r.json()).settings; };
      const put = async (token, patch) => fetch(url, { method: 'PUT', headers: { 'x-pulse-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const tone = { id: 'test', title: 'Shared ringtone', url: '/api/ringtones/audio?u=' + encodeURIComponent('https://zvukogram.com/mp3/cats/test.mp3'), startSec: 2 };
      try { ${body} } finally { await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

test("ringtone choices are shared between sessions, isolated by account and survive restart", t => {
  const directory = fixture(t);
  run(directory, `
    assert.equal((await read(first.token)).initialized, false);
    assert.equal((await put(first.token, { ringtone: tone })).status, 200);
    assert.equal((await read(second.token)).ringtone.title, tone.title);
    assert.equal((await read(other.token)).ringtone, null);
    assert.equal((await put(second.token, { ringtone: null, ifAbsent: true })).status, 200);
    assert.equal((await read(first.token)).ringtone.id, tone.id);
    assert.equal(auth.listUsers().find(u => u.id === first.userId).ringtoneSettings, undefined);
    assert.deepEqual(notices, [first.userId]);
  `);
  run(directory, `
    assert.equal((await read(second.token)).ringtone.title, tone.title);
    assert.equal((await put(second.token, { ringtone: null })).status, 200);
    assert.equal((await read(first.token)).ringtone, null);
    assert.equal((await read(first.token)).initialized, true);
  `);
});

test("custom clips and editable sources are saved for the account with fresh signed URLs", t => {
  const directory = fixture(t);
  run(directory, `
    const custom = { id: 'custom', title: 'My clip', url: clip, source: { url: source, name: 'original.wav', startSec: 1, endSec: 5 } };
    assert.equal((await put(first.token, { custom })).status, 200);
    const shared = await read(second.token);
    assert.equal(shared.ringtone.title, custom.title);
    assert.match(shared.custom.url, /[?]exp=.+&sig=/);
    assert.match(shared.custom.source.url, /[?]exp=.+&sig=/);
    assert.equal(auth.getUserById(first.userId).ringtoneSettings.custom.url, clip);
    assert.equal((await read(other.token)).custom, null);
    assert.equal((await put(other.token, { custom })).status, 400);
    assert.equal((await put(first.token, { custom: { ...custom, url: forbidden } })).status, 400);
    assert.equal((await put(first.token, { ringtone: tone })).status, 200);
    assert.equal((await read(second.token)).custom.title, custom.title);
  `);
  run(directory, `
    assert.equal((await read(second.token)).custom.source.name, 'original.wav');
    assert.equal((await put(second.token, { ringtone: { id: 'custom' } })).status, 200);
    assert.equal((await read(first.token)).ringtone.id, 'custom');
    assert.equal((await put(first.token, { custom: null })).status, 200);
    assert.equal((await read(second.token)).ringtone, null);
    assert.equal((await read(second.token)).custom, null);
  `);
});

test("ringtone preferences reject unauthenticated requests and invalid choices without changing the saved tone", t => {
  run(fixture(t), `
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await put(first.token, { ringtone: tone })).status, 200);
    for (const ringtone of [{ ...tone, url: 'https://example.com/file.mp3' }, { ...tone, startSec: -1 }, { id: 'custom' }]) {
      assert.equal((await put(first.token, { ringtone })).status, 400);
      assert.equal((await read(second.token)).ringtone.id, tone.id);
    }
    auth.logoutToken(first.token);
    assert.equal((await put(first.token, { ringtone: null })).status, 401);
    assert.equal((await read(second.token)).ringtone.id, tone.id);
  `);
});
