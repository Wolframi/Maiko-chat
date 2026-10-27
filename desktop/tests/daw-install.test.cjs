const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDawInstaller } = require('../daw-install.cjs');

test('direct VST3 installation copies only the plug-in, verifies versions and handles concurrent clicks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maiko-vst-install-'));
  try {
    const source = path.join(root, 'source.vst3'), directory = path.join(root, 'VST3');
    await fs.writeFile(source, 'verified VST3 v1');
    const installer = createDawInstaller({ source, directory });
    assert.equal(await installer.installed(), false);
    assert.deepEqual(await Promise.all([installer.install(), installer.install()]), [{ installed: true }, { installed: true }]);
    assert.equal(await installer.installed(), true);
    const contents = path.join(directory, 'Maiko DAW Bridge.vst3', 'Contents');
    const target = path.join(contents, 'x86_64-win', 'Maiko DAW Bridge.vst3');
    assert.deepEqual(await fs.readdir(directory), ['Maiko DAW Bridge.vst3']);
    assert.deepEqual(await fs.readdir(contents), ['x86_64-win']);
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['Maiko DAW Bridge.vst3']);
    const first = (await fs.stat(target)).mtimeMs;
    await installer.install(); assert.equal((await fs.stat(target)).mtimeMs, first, 'Already installed module is not replaced');
    await fs.writeFile(source, 'verified VST3 v2');
    assert.equal(await installer.installed(), false);
    await fs.writeFile(path.join(contents, 'INSTALL.txt'), 'old instructions');
    await fs.writeFile(path.join(contents, 'THIRD-PARTY-NOTICES.txt'), 'old companion');
    await fs.writeFile(path.join(contents, 'user-file.txt'), 'keep');
    await installer.install();
    assert.equal(await fs.readFile(target, 'utf8'), 'verified VST3 v2');
    assert.deepEqual((await fs.readdir(contents)).sort(), ['user-file.txt', 'x86_64-win']);
    await fs.unlink(source);
    await assert.rejects(installer.install(), { code: 'ENOENT' });
    assert.equal(await fs.readFile(target, 'utf8'), 'verified VST3 v2', 'Failed install preserves current plug-in');
    await fs.writeFile(source, 'verified VST3 v3');
    assert.deepEqual(await installer.install(), { installed: true }, 'Can retry after failure');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
