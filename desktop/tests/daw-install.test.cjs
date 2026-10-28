const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDawInstaller, systemVst3Directory } = require('../daw-install.cjs');

test('FL Studio installation uses the system x64 VST3 location, including from a 32-bit environment', () => {
  const common64 = path.resolve('Program Files', 'Common Files');
  assert.equal(systemVst3Directory({ CommonProgramW6432: common64,
    CommonProgramFiles: path.resolve('Program Files (x86)', 'Common Files'), LOCALAPPDATA: os.tmpdir() }),
  path.join(common64, 'VST3'));
  assert.throws(() => systemVst3Directory({}), /системная папка VST3/);
});

test('a per-user installation does not report installed for FL Studio; denied system writes request elevation and can retry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maiko-vst-system-'));
  const originalCommon = process.env.CommonProgramW6432;
  const copy = fs.copyFile.bind(fs);
  try {
    process.env.CommonProgramW6432 = path.join(root, 'Common Files');
    const source = path.join(root, 'source.vst3');
    await fs.writeFile(source, 'current bridge');
    await createDawInstaller({ source, directory: path.join(root, 'user', 'VST3') }).install();
    const directory = systemVst3Directory();
    const target = path.join(directory, 'Maiko DAW Bridge.vst3', 'Contents', 'x86_64-win', 'Maiko DAW Bridge.vst3');
    let elevations = 0, cancel = true;
    const installer = createDawInstaller({ source, elevateInstall: async (file) => {
      elevations++;
      assert.equal(file, source);
      if (cancel) throw new Error('UAC cancelled');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await copy(file, target);
    } });
    t.mock.method(fs, 'copyFile', async (from, to) => {
      if (to.startsWith(directory)) throw Object.assign(new Error('System folder requires elevation'), { code: 'EACCES' });
      return copy(from, to);
    });
    assert.equal(await installer.installed(), false);
    await assert.rejects(installer.install(), /UAC cancelled/);
    assert.equal(await installer.installed(), false);
    cancel = false;
    assert.deepEqual(await installer.install(), { installed: true });
    assert.equal(await installer.installed(), true);
    assert.equal(elevations, 2);
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['Maiko DAW Bridge.vst3']);
  } finally {
    t.mock.restoreAll();
    if (originalCommon === undefined) delete process.env.CommonProgramW6432;
    else process.env.CommonProgramW6432 = originalCommon;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a locked system VST3 preserves the previous module without requesting elevation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maiko-vst-locked-'));
  const originalCommon = process.env.CommonProgramW6432;
  try {
    process.env.CommonProgramW6432 = path.join(root, 'Common Files');
    const source = path.join(root, 'source.vst3');
    let elevations = 0;
    const installer = createDawInstaller({ source, elevateInstall: async () => { elevations++; } });
    await fs.writeFile(source, 'previous bridge');
    await installer.install();
    await fs.writeFile(source, 'new bridge');
    t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('DLL locked'), { code: 'EPERM' }); });
    await assert.rejects(installer.install(), { code: 'EPERM' });
    const binary = path.join(systemVst3Directory(), 'Maiko DAW Bridge.vst3', 'Contents', 'x86_64-win', 'Maiko DAW Bridge.vst3');
    assert.equal(await fs.readFile(binary, 'utf8'), 'previous bridge');
    assert.deepEqual(await fs.readdir(path.dirname(binary)), ['Maiko DAW Bridge.vst3']);
    assert.equal(elevations, 0);
  } finally {
    t.mock.restoreAll();
    if (originalCommon === undefined) delete process.env.CommonProgramW6432;
    else process.env.CommonProgramW6432 = originalCommon;
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
