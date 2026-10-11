const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const output = path.resolve(__dirname, '../test-output');
const userData = path.join(output, `profile-${Date.now()}`);
const executablePath = process.env.MAIKO_TEST_EXECUTABLE || require('electron');
const args = process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..'), '--local'];
const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;

async function waitReady(app) {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.maikoDesktop !== 'undefined', null, { polling: 100, timeout: 30_000 });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.maikoDesktop.state());
    // A cached page can become ready before Playwright attaches to the child
    // WebContentsView, especially on the second launch of the same profile.
    if (state.phase === 'ready' && app.windows().some((page) => /^https?:/.test(page.url()))) return page;
    if (state.phase === 'error') throw new Error(state.message);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('Electron did not finish loading the site');
}
async function main() {
  await fs.mkdir(userData, { recursive: true });
  let app;
  try {
    app = await electron.launch({ executablePath, args, env, timeout: 120_000 });
    const shell = await waitReady(app);
    const initialState = await shell.evaluate(() => window.maikoDesktop.state());
    assert.equal(initialState.phase, 'ready');
    const pages = app.windows();
    const site = pages.find((page) => page.url().startsWith('http://127.0.0.1:')) || pages.find((page) => page.url().startsWith('https://'));
    assert.ok(site, 'The site is hosted in a separate WebContentsView');
    await site.getByRole('textbox', { name: 'Логин', exact: true }).waitFor({ timeout: 60_000 });
    assert.deepEqual(await site.evaluate(() => ({ node: typeof window.require, bridge: typeof window.maikoDesktop })), { node: 'undefined', bridge: 'undefined' });
    const preferences = await app.evaluate(({ webContents }) => {
      const content = webContents.getAllWebContents().find((entry) => /^https?:/.test(entry.getURL()));
      const prefs = content.getLastWebPreferences();
      return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
    });
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });

    await shell.getByRole('button', { name: 'Настройки подключения' }).click();
    await shell.getByLabel('Адрес сайта', { exact: true }).fill('http://example.com');
    await shell.getByRole('button', { name: 'Подключиться', exact: true }).click();
    await shell.getByRole('alert').filter({ hasText: 'HTTPS' }).waitFor();
    await shell.getByRole('button', { name: 'Назад', exact: true }).click();

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    const [contentWidth, contentHeight] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
    await site.waitForFunction(([width, height]) => window.innerWidth === width && window.innerHeight === height,
      [contentWidth - 12, contentHeight - 48], { polling: 100 });
    await shell.getByRole('button', { name: 'Развернуть', exact: true }).click();
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).maximized, true);
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), await app.evaluate(({ BrowserWindow, screen }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).workArea));
    await shell.getByRole('button', { name: 'Восстановить', exact: true }).click();
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).maximized, false);

    await site.evaluate(() => { localStorage.setItem('maiko-desktop-smoke', 'persisted'); });
    const captureRequest = site.evaluate(async () => {
      try { await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); return 'unexpected'; }
      catch (error) { return error.name; }
    });
    const picker = await app.waitForEvent('window', { predicate: (page) => page !== shell && page !== site, timeout: 20_000 });
    await picker.getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.ok(['AbortError', 'NotAllowedError'].includes(await captureRequest));
    assert.equal(app.windows().length, 2);

    await site.screenshot({ path: path.join(output, 'site.png') });
    const full = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    await fs.writeFile(path.join(output, 'desktop.png'), Buffer.from(full, 'base64'));
    await app.close(); app = undefined;
    app = await electron.launch({ executablePath, args, env, timeout: 120_000 });
    await waitReady(app);
    const restored = app.windows().find((page) => /^https?:/.test(page.url()));
    assert.equal(await restored.evaluate(() => localStorage.getItem('maiko-desktop-smoke')), 'persisted');
    await restored.evaluate(() => localStorage.removeItem('maiko-desktop-smoke'));
    console.log('Electron smoke passed: site, isolation, settings validation, viewport, window controls, capture cancellation, session persistence.');
  } finally { if (app) await app.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
