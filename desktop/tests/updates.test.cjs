const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates } = require('../updates.cjs');

function fixture(options = {}) {
  const updater = new EventEmitter();
  let state, installed = 0, stopped = 0;
  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.1.9' });
  };
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 52.3 });
    updater.emit('update-downloaded', { version: '1.1.9' });
  };
  updater.quitAndInstall = (silent, restart) => {
    assert.equal(stopped, 1, 'local server stops before restarting');
    assert.equal(silent, false); assert.equal(restart, true); installed++;
  };
  const controller = createUpdates({ app: { isPackaged: true, getVersion: () => '1.1.8' },
    platform: 'win32', portable: false, getUpdater: () => updater,
    publish: (patch) => { state = patch.update; }, log: () => {},
    beforeInstall: async () => { stopped++; }, ...options });
  return { updater, controller, state: () => state, installed: () => installed };
}

test('updates check, download and install only after explicit commands', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false);
  await assert.rejects(f.controller.action('install'));
  await f.controller.action('check');
  assert.equal(f.state().phase, 'available');
  assert.equal(f.installed(), 0);
  await f.controller.action('download');
  assert.equal(f.state().phase, 'downloaded');
  assert.equal(f.state().progress, 100);
  assert.equal(f.installed(), 0);
  await f.controller.action('check');
  assert.equal(f.state().phase, 'downloaded', 'checks preserve a pending installer');
  await f.controller.action('install');
  assert.equal(f.installed(), 1);
  f.controller.dispose();
});

test('failed downloads can retry and concurrent commands cannot interrupt a download', async () => {
  const f = fixture();
  await f.controller.action('check');
  f.updater.downloadUpdate = async () => { throw new Error('Offline'); };
  await f.controller.action('download');
  assert.equal(f.state().retryAction, 'download');
  let finish, downloads = 0;
  f.updater.downloadUpdate = () => { downloads++; return new Promise((resolve) => { finish = resolve; }); };
  const download = f.controller.action('download');
  await f.controller.action('check'); await f.controller.action('download');
  assert.equal(downloads, 1);
  assert.equal(f.state().phase, 'downloading');
  f.updater.emit('update-downloaded', { version: '1.1.9' });
  finish(); await download;
  assert.equal(f.state().phase, 'downloaded');
  f.controller.dispose();
});

test('network check failures recover and disposal removes timers and listeners', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error('No releases'); };
  await f.controller.action('check');
  assert.equal(f.state().phase, 'error'); assert.equal(f.state().retryAction, 'check');
  f.updater.checkForUpdates = async () => f.updater.emit('update-not-available');
  await f.controller.action('check'); assert.equal(f.state().phase, 'idle');
  await assert.rejects(f.controller.action('arbitrary-url'));
  f.controller.start(); f.controller.dispose();
  assert.equal(f.updater.eventNames().length, 0);
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
