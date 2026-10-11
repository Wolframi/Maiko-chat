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
    await page.locator('#update-action').waitFor();
    assert.equal(await page.locator('input[type="url"], #settings-screen, #change-url').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.maikoDesktop.connect), 'undefined');
    assert.equal(await page.locator('#titlebar #app-version').textContent(), `v${version}`);
    assert.equal(await page.locator('#update-action').isDisabled(), true, 'Development updates are disabled');
    const state = await page.evaluate(() => window.maikoDesktop.state());
    assert.equal(state.phase, 'ready');
    await app.evaluate(({ BrowserWindow, ipcMain }, { state, version }) => {
      const win = BrowserWindow.getAllWindows()[0];
      global.updateTestActions = [];
      const send = (update) => win.webContents.send('desktop:state-changed', { ...state,
        update: { currentVersion: version, version: '9.9.9', progress: 0, ...update } });
      global.sendUpdateTestState = send;
      ipcMain.removeHandler('desktop:update');
      ipcMain.handle('desktop:update', async (_event, action) => {
        global.updateTestActions.push(action);
        if (action === 'check') send({ phase: 'available', message: 'Доступна версия 9.9.9.' });
        if (action === 'download') {
          send({ phase: 'downloading', progress: 47, message: 'Скачиваем обновление…' });
          await new Promise((resolve) => setTimeout(resolve, 1500));
          send({ phase: 'downloaded', progress: 100, message: 'Обновление готово.' });
        }
        if (action === 'install') send({ phase: 'installing', message: 'Перезапускаем приложение…' });
      });
      send({ phase: 'idle', message: 'Проверяем новые версии автоматически.' });
    }, { state, version });
    await page.getByRole('button', { name: 'Проверить обновления', exact: true }).click();
    await page.getByRole('button', { name: 'Скачать обновление 9.9.9', exact: true }).click();
    await page.locator('#update-progress:not([hidden])').waitFor();
    assert.equal(await page.locator('.update-wheel').evaluate((icon) => getComputedStyle(icon).animationName), 'spin');
    await page.getByRole('button', { name: 'Перезапустить и установить 9.9.9', exact: true }).waitFor();
    assert.equal(await page.locator('#titlebar #app-version').textContent(), `v${version}`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 800, height: 600 }));
    const dock = await page.locator('#update-dock').boundingBox();
    const controls = await page.locator('[data-action="minimize"]').boundingBox();
    assert.ok(dock.y >= 0 && dock.y + dock.height <= 42 && dock.x + dock.width <= controls.x, 'Dock fits beside window controls at minimum size');
    await fs.mkdir(output, { recursive: true });
    assert.equal(await page.locator('#connection-screen').isVisible(), false, 'Update controls leave the site open');
    await page.screenshot({ path: path.join(output, 'updates.png'), timeout: 60_000 });
    await page.getByRole('button', { name: 'Перезапустить и установить 9.9.9', exact: true }).click();
    assert.deepEqual(await app.evaluate(() => global.updateTestActions), ['check', 'download', 'install']);
    assert.equal(await page.locator('#update-action').isDisabled(), true);
    console.log('Update dock passed in Electron: version, spinner, progress, direct check/download/install, minimum window size and no site input.');
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
