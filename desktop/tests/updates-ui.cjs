const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixtureServer } = require('./viewport.cjs');
const { version } = require('../package.json');

async function main() {
  const server = await fixtureServer();
  const output = path.resolve(__dirname, '../test-output');
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1',
    MAIKO_DESKTOP_USER_DATA: path.join(output, `updates-${Date.now()}`),
    MAIKO_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/updated` };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120_000 });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await page.waitForFunction(() => !!window.maikoDesktop, null, { timeout: 60_000 });
    await page.waitForFunction(() => document.body.dataset.phase === 'ready');
    assert.equal(await page.locator('input[type="url"], #settings-screen, #change-url').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.maikoDesktop.connect), 'undefined');
    assert.equal(await page.locator('#titlebar #app-version').textContent(), `v${version}`);
    assert.equal(await page.locator('#update-action').isDisabled(), true, 'Development updates are disabled');
    const state = await page.evaluate(() => window.maikoDesktop.state());
    const identity = await app.evaluate(({ BrowserWindow }) => ({ pid: process.pid, windowId: BrowserWindow.getAllWindows()[0].id }));
    await app.evaluate(({ app, BrowserWindow, ipcMain }, { state, version }) => {
      const testRequire = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { EventEmitter } = testRequire('node:events');
      const { createUpdates } = testRequire('./updates.cjs');
      const win = BrowserWindow.getAllWindows()[0];
      global.updateTestActions = [];
      global.updateTestInstalls = [];
      global.updateTestPrepared = false;
      const send = (update) => win.webContents.send('desktop:state-changed', { ...state, update });
      global.sendUpdateTestState = (update) => send({ currentVersion: version, version: '9.9.9', progress: 0, ...update });
      const updater = new EventEmitter();
      updater.checkForUpdates = async () => {
        updater.emit('checking-for-update');
        await new Promise(resolve => { global.finishUpdateTestCheck = resolve; });
        updater.emit('update-available', { version: '9.9.9' });
      };
      updater.downloadUpdate = async () => {
        updater.emit('download-progress', { percent: 47 });
        await new Promise(resolve => { global.finishUpdateTestDownload = resolve; });
        updater.emit('update-downloaded', { version: '9.9.9' });
      };
      updater.quitAndInstall = (...args) => {
        if (!global.updateTestPrepared) throw new Error('Session was not prepared');
        global.updateTestInstalls.push(args);
      };
      global.updateTestController = createUpdates({ app: { isPackaged: true, getVersion: () => version },
        platform: 'win32', portable: false, publish: patch => send(patch.update), log: () => {}, getUpdater: () => updater,
        prepareInstall: async () => {
          await new Promise(resolve => { global.finishUpdateTestPreparation = resolve; });
          global.updateTestPrepared = true;
        } });
      ipcMain.removeHandler('desktop:update');
      ipcMain.handle('desktop:update', async (_event, action) => {
        global.updateTestActions.push(action);
        await global.updateTestController.action(action);
      });
      global.sendUpdateTestState({ phase: 'current', message: 'Обновлено. Установлена последняя версия.' });
    }, { state, version });
    await page.waitForFunction(() => document.querySelector('#update-label').textContent === 'Обновлено');
    assert.equal(await page.locator('#update-action').isDisabled(), false);
    await page.getByRole('button', { name: 'Проверить обновления', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#update-dock').dataset.phase === 'checking');
    assert.equal(await page.locator('#update-action').isDisabled(), true);
    assert.equal(await page.locator('#update-label').textContent(), 'Проверка…');
    await app.evaluate(() => global.finishUpdateTestCheck());
    await page.getByRole('button', { name: 'Обновить до версии 9.9.9 с автоматическим перезапуском', exact: true }).click();
    await page.locator('#update-progress:not([hidden])').waitFor();
    assert.equal(await page.locator('.update-wheel').evaluate(icon => getComputedStyle(icon).animationName), 'spin');
    await app.evaluate(() => global.finishUpdateTestDownload());
    await page.waitForFunction(() => document.querySelector('#update-dock').dataset.phase === 'installing');
    assert.equal(await page.locator('#connection-screen').isVisible(), false, 'No redundant site reload before installing');
    assert.equal(await page.locator('#update-label').textContent(), 'Установка…');
    assert.equal(await page.locator('#update-action').isDisabled(), true);
    assert.match(await page.locator('#update-dock').getAttribute('title'), /откроется автоматически после установки/);
    assert.equal(await page.locator('#titlebar #app-version').textContent(), `v${version}`, 'Do not fake the new version');
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => ({ pid: process.pid, windowId: BrowserWindow.getAllWindows()[0].id })), identity);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 800, height: 600 }));
    const dock = await page.locator('#update-dock').boundingBox();
    const controls = await page.locator('[data-action="minimize"]').boundingBox();
    assert.ok(dock.y >= 0 && dock.y + dock.height <= 42 && dock.x + dock.width <= controls.x, 'Dock fits at minimum window size');
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'updates.png'), timeout: 60_000 });
    await app.evaluate(async () => {
      global.finishUpdateTestPreparation();
      const deadline = Date.now() + 5000;
      while (!global.updateTestInstalls.length) {
        if (Date.now() > deadline) throw new Error('Installer was not invoked');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await global.updateTestController.action('check');
    });
    assert.deepEqual(await app.evaluate(() => global.updateTestInstalls), [[true, true]]);
    assert.deepEqual(await app.evaluate(() => global.updateTestActions), ['check', 'download']);
    for (const retryAction of ['check', 'download', 'apply']) {
      await app.evaluate((_electron, retryAction) => global.sendUpdateTestState({ phase: 'error', retryAction, message: 'Ошибка обновления. Повторите попытку.' }), retryAction);
      await page.waitForFunction(retryAction => document.querySelector('#update-action').dataset.command === retryAction && document.querySelector('#update-label').textContent === 'Повторить', retryAction);
      assert.equal(await page.locator('#update-action').isDisabled(), false);
    }
    console.log('Update UI passed: real controller, check/download/install, no redundant reload, honest version, silent install and post-install launch, retries and minimum window size. Installer execution is mocked.');
  } finally {
    if (app) {
      await app.evaluate(() => global.updateTestController?.dispose()).catch(() => {});
      await app.close();
    }
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
