const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates } = require('../updates.cjs');

function fixture(options = {}) {
  const updater = new EventEmitter();
  let state, prepared = 0;
  const installs = [];
  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.1.9' });
  };
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 52.3 });
    updater.emit('update-downloaded', { version: '1.1.9' });
  };
  updater.quitAndInstall = (...args) => {
    assert.equal(state.phase, 'installing');
    assert.ok(prepared > 0, 'Prepare the session before starting NSIS');
    installs.push(args);
  };
  const controller = createUpdates({ app: { isPackaged: true, getVersion: () => '1.1.8' },
    platform: 'win32', portable: false, getUpdater: () => updater,
    publish: (patch) => { state = patch.update; }, log: () => {},
    ...options, prepareInstall: async () => { await options.prepareInstall?.(); prepared++; } });
  return { updater, controller, state: () => state, installs, prepared: () => prepared };
}

test('completed downloads automatically install silently and let NSIS launch the new version', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, true);
  assert.equal(f.updater.autoRunAppAfterInstall, false, 'A normal close must not reopen the app');
  assert.equal(f.updater.disableWebInstaller, true);
  assert.equal(f.updater.allowDowngrade, false);
  await assert.rejects(f.controller.action('apply'));
  await f.controller.action('check');
  assert.equal(f.state().phase, 'available');
  assert.equal(f.installs.length, 0);
  await f.controller.action('download');
  assert.equal(f.state().phase, 'installing');
  assert.equal(f.state().progress, 100);
  assert.equal(f.state().currentVersion, '1.1.8', 'Never report a downloaded version as running');
  assert.deepEqual(f.installs, [[true, true]], 'Silent install, force run only after replacement');
  await f.controller.action('check');
  await f.controller.action('apply');
  await f.controller.action('download');
  assert.equal(f.installs.length, 1, 'The installer must only start once');
  f.controller.dispose();
});

test('failed downloads retry and concurrent commands cannot interrupt a download', async () => {
  const f = fixture();
  await f.controller.action('check');
  f.updater.downloadUpdate = async () => { throw new Error('Offline'); };
  await f.controller.action('download');
  assert.equal(f.state().retryAction, 'download');
  let finish, downloads = 0;
  f.updater.downloadUpdate = () => { downloads++; return new Promise(resolve => { finish = resolve; }); };
  const download = f.controller.action('download');
  await f.controller.action('check'); await f.controller.action('download');
  assert.equal(downloads, 1);
  assert.equal(f.installs.length, 0, 'Never quit before the download finishes');
  f.updater.emit('update-downloaded', { version: '1.1.9' });
  finish(); await download;
  assert.equal(f.state().phase, 'installing');
  assert.deepEqual(f.installs, [[true, true]]);
  f.controller.dispose();
});

test('network check failures recover and disposal removes timers and listeners', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error('No releases'); };
  await f.controller.action('check');
  assert.equal(f.state().phase, 'error'); assert.equal(f.state().retryAction, 'check');
  f.updater.checkForUpdates = async () => f.updater.emit('update-not-available');
  await f.controller.action('check'); assert.equal(f.state().phase, 'current');
  assert.equal(f.state().version, ''); assert.equal(f.state().progress, 0);
  await assert.rejects(f.controller.action('arbitrary-url'));
  f.controller.start(); f.controller.dispose();
  assert.equal(f.updater.eventNames().length, 0);
});

test('failed session preparation retries installation without downloading again', async () => {
  let attempts = 0;
  const f = fixture({ prepareInstall: async () => { if (++attempts === 1) throw new Error('Flush failed'); } });
  await f.controller.action('check'); await f.controller.action('download');
  assert.equal(f.state().phase, 'error');
  assert.equal(f.state().retryAction, 'apply');
  assert.equal(f.installs.length, 0);
  f.updater.downloadUpdate = () => { throw new Error('Must not download again'); };
  f.updater.checkForUpdates = () => { throw new Error('Must not erase a pending installer'); };
  await f.controller.action('check');
  assert.equal(f.state().retryAction, 'apply');
  await f.controller.action('apply');
  assert.equal(f.state().phase, 'installing');
  assert.equal(attempts, 2);
  assert.deepEqual(f.installs, [[true, true]]);
  f.controller.dispose();
});

test('preparation finishes before quitting and cannot start twice concurrently', async () => {
  let finish;
  const f = fixture({ prepareInstall: () => new Promise(resolve => { finish = resolve; }) });
  await f.controller.action('check');
  const downloading = f.controller.action('download');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().phase, 'installing');
  assert.equal(f.installs.length, 0);
  await f.controller.action('apply'); await f.controller.action('check');
  finish(); await downloading;
  assert.deepEqual(f.installs, [[true, true]]);
  f.controller.dispose();
});

test('installer failures keep the downloaded update and allow another install attempt', async () => {
  for (const emitted of [false, true]) {
    const f = fixture();
    const install = f.updater.quitAndInstall;
    f.updater.quitAndInstall = () => {
      const error = new Error('Spawn failed');
      if (emitted) f.updater.emit('error', error);
      else throw error;
    };
    await f.controller.action('check'); await f.controller.action('download');
    assert.equal(f.state().phase, 'error');
    assert.equal(f.state().retryAction, 'apply');
    f.updater.quitAndInstall = install;
    await f.controller.action('apply');
    assert.deepEqual(f.installs, [[true, true]]);
    f.controller.dispose();
  }
});

test('NSIS receives --force-run so a silent assisted install launches only after installing', () => {
  const { NsisUpdater } = require('electron-updater');
  const updater = new NsisUpdater(null, { version: '1.1.8', isPackaged: true });
  let invocation;
  updater._logger = { info() {} };
  updater.downloadedUpdateHelper = { file: 'C:\\updates\\Maiko-Setup-1.1.9.exe' };
  updater.spawnLog = async (file, args) => { invocation = { file, args }; };
  assert.equal(updater.doInstall({ isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false }), true);
  assert.deepEqual(invocation, { file: 'C:\\updates\\Maiko-Setup-1.1.9.exe', args: ['--updated', '/S', '--force-run'] });
});

test('development, portable and test runs never instantiate the updater', async () => {
  for (const options of [{ portable: true }, { testing: true },
    { app: { isPackaged: false, getVersion: () => '1.1.8' } }, { platform: 'linux' }]) {
    const f = fixture({ ...options, getUpdater: () => { throw new Error('Must not load'); } });
    assert.equal(f.state().phase, 'disabled');
    await assert.rejects(f.controller.action('check'));
    f.controller.start(); f.controller.dispose();
  }
});
