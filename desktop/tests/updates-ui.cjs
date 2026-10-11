const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

async function main() {
  const server = http.createServer((_req, res) => res.end('<!doctype html><title>Update test</title>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const output = path.resolve(__dirname, '../test-output');
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1',
    MAIKO_DESKTOP_USER_DATA: path.join(output, `updates-${Date.now()}`),
    MAIKO_DESKTOP_URL: `http://127.0.0.1:${server.address().port}` };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120_000 });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await page.waitForFunction(() => !!window.maikoDesktop, null, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Настройки подключения' }).click();
    await page.locator('#update-action').waitFor();
    assert.equal(await page.locator('#update-action').isDisabled(), true, 'Development updates are disabled');
    const state = await page.evaluate(() => window.maikoDesktop.state());
    await app.evaluate(({ BrowserWindow, ipcMain }, state) => {
      const win = BrowserWindow.getAllWindows()[0];
      global.updateTestActions = [];
      const send = (update) => win.webContents.send('desktop:state-changed', { ...state,
        update: { currentVersion: '1.1.8', version: '1.1.9', progress: 0, ...update } });
      ipcMain.removeHandler('desktop:update');
      ipcMain.handle('desktop:update', async (_event, action) => {
        global.updateTestActions.push(action);
        if (action === 'check') send({ phase: 'available', message: 'Доступна версия 1.1.9.' });
        if (action === 'download') {
          send({ phase: 'downloading', progress: 47, message: 'Скачиваем обновление…' });
          await new Promise((resolve) => setTimeout(resolve, 500));
          send({ phase: 'downloaded', progress: 100, message: 'Обновление готово.' });
        }
        if (action === 'install') send({ phase: 'installing', message: 'Перезапускаем приложение…' });
      });
      send({ phase: 'idle', message: 'Проверяем новые версии автоматически.' });
    }, state);
    await page.getByRole('button', { name: 'Проверить обновления', exact: true }).click();
    await page.getByRole('button', { name: 'Скачать 1.1.9', exact: true }).click();
    await page.getByRole('button', { name: 'Перезапустить и установить', exact: true }).waitFor();
    assert.equal(await page.locator('#update-notice').isVisible(), true);
    assert.equal(await page.locator('#app-version').textContent(), 'Версия 1.1.8');
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'updates.png'), timeout: 60_000 });
    await page.getByRole('button', { name: 'Перезапустить и установить', exact: true }).click();
    assert.deepEqual(await app.evaluate(() => global.updateTestActions), ['check', 'download', 'install']);
    assert.equal(await page.locator('#update-action').isDisabled(), true);
    console.log('Update UI passed in Electron: disabled development mode, check, download, notification and explicit install.');
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
