const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const output = path.resolve(__dirname, '../test-output', `downloads-${Date.now()}`);
const payload = Buffer.from('%PDF-1.4\noriginal file bytes\n');
const title = 'Отчёт за октябрь.pdf';
const route = '/uploads/12345678-1234-1234-1234-123456789abc.pdf';
const href = `${route}?download=1&name=${encodeURIComponent(title)}`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/uploads/')) {
    if (!req.headers.cookie?.includes('download-session=yes')) { res.writeHead(403); res.end('Forbidden'); return; }
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(new URL(req.url, 'http://localhost').searchParams.get('name') || title)}`);
    if (req.url.includes('slow=1') || req.url.includes('broken=1')) {
      res.setHeader('content-length', 10_000_000);
      res.write(payload);
      if (req.url.includes('broken=1')) {
        const timeout = setTimeout(() => res.destroy(), 1000);
        res.on('close', () => clearTimeout(timeout));
      } else {
        const timer = setInterval(() => res.write(Buffer.alloc(1000, 42)), 100);
        res.on('close', () => clearInterval(timer));
      }
    } else { res.setHeader('content-length', payload.length); res.end(payload); }
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('set-cookie', 'download-session=yes; HttpOnly; SameSite=Lax; Path=/');
  res.end(`<!doctype html><html lang="ru"><title>Проверка скачивания</title><body style="background:#0c0c0e;color:white;font-family:Segoe UI;padding:32px"><h1>Скачивание файлов</h1>
    <a href="${href}" download="${title}">Скачать файл</a>
    <button onclick="window.open('${href}', '_blank')">Скачать из старого меню</button>
    <a href="${href}&slow=1" download>Медленная загрузка</a>
    <a href="${href}&broken=1" download>Ошибка соединения</a>
    </body></html>`);
});

async function main() {
  await fs.mkdir(output, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: path.join(output, 'profile'),
    MAIKO_DESKTOP_DOWNLOADS_DIR: output, MAIKO_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/` };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  async function waitState(shell, predicate) {
    const deadline = Date.now() + 60_000;
    let state;
    while (Date.now() < deadline) {
      state = await shell.evaluate(() => window.maikoDesktop.state());
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Download state timed out: ${JSON.stringify(state.downloads)}`);
  }
  async function launch() {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120_000 });
    const shell = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await shell.waitForFunction(() => document.body.dataset.phase === 'ready', null, { timeout: 60_000 });
    await shell.waitForFunction(() => !!window.maikoDesktop);
    return shell;
  }
  try {
    let shell = await launch();
    const site = app.windows().find((page) => /^http:/.test(page.url()));
    assert.ok(site);
    assert.deepEqual(await site.evaluate(() => ({ node: typeof window.require, bridge: typeof window.maikoDesktop })), { node: 'undefined', bridge: 'undefined' });
    await site.getByRole('link', { name: 'Скачать файл', exact: true }).click();
    await waitState(shell, (s) => s.downloads.entries[0]?.phase === 'completed');
    let state = await shell.evaluate(() => window.maikoDesktop.state());
    assert.equal(state.downloads.entries[0].name, title);
    assert.deepEqual(await fs.readFile(state.downloads.entries[0].path), payload);
    await site.getByRole('button', { name: 'Скачать из старого меню' }).click();
    await waitState(shell, (s) => s.downloads.entries.length === 2 && s.downloads.entries[0].phase === 'completed');
    state = await shell.evaluate(() => window.maikoDesktop.state());
    assert.equal(state.downloads.entries[0].name, 'Отчёт за октябрь (1).pdf');
    assert.deepEqual(await fs.readFile(state.downloads.entries[0].path), payload);
    const completedPath = state.downloads.entries[0].path;
    await app.evaluate(({ shell }) => {
      global.revealedDownloads = []; global.openedDownloadFolders = [];
      shell.showItemInFolder = (filename) => global.revealedDownloads.push(filename);
      shell.openPath = async (filename) => { global.openedDownloadFolders.push(filename); return ''; };
    });
    const folderButton = shell.getByRole('button', { name: 'Открыть папку загрузок', exact: true });
    await folderButton.hover();
    const deadline = Date.now() + 30_000;
    let panel;
    while (!panel && Date.now() < deadline) {
      panel = app.windows().find((page) => page.url().endsWith('/downloads-panel.html'));
      if (!panel) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(panel, 'Hover shows an in-window downloads panel');
    await panel.getByRole('button', { name: /Открыть папку с файлом/ }).first().hover();
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await folderButton.getAttribute('aria-expanded'), 'true', 'The list remains open while the pointer moves onto it');
    await panel.getByRole('button', { name: /Открыть папку с файлом/ }).first().click();
    assert.deepEqual(await app.evaluate(() => global.revealedDownloads), [completedPath]);
    await shell.getByRole('button', { name: 'Открыть папку загрузок', exact: true }).click();
    assert.deepEqual(await app.evaluate(() => global.openedDownloadFolders), [path.join(output, 'Maiko')]);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'The list is part of the same window');
    await site.getByRole('link', { name: 'Медленная загрузка' }).click();
    const pending = await waitState(shell, (s) => s.downloads.entries[0]?.phase === 'downloading');
    const partialPath = pending.downloads.entries[0].path;
    await folderButton.hover();
    await panel.getByRole('button', { name: 'Отменить скачивание' }).hover();
    await panel.getByRole('button', { name: 'Отменить скачивание' }).click();
    await waitState(shell, (s) => s.downloads.entries[0]?.phase === 'cancelled');
    await assert.rejects(fs.stat(partialPath), { code: 'ENOENT' });
    await site.getByRole('link', { name: 'Ошибка соединения' }).click();
    await waitState(shell, (s) => s.downloads.entries[0]?.phase === 'error');
    state = await shell.evaluate(() => window.maikoDesktop.state());
    await assert.rejects(fs.stat(state.downloads.entries[0].path), { code: 'ENOENT' });
    await fs.unlink(completedPath);
    await folderButton.hover();
    await panel.getByRole('button', { name: /Открыть папку с файлом/ }).first().hover();
    await panel.getByRole('button', { name: /Открыть папку с файлом/ }).first().click();
    assert.match(await panel.getByRole('alert').textContent(), /перемещён или удалён/);
    await panel.keyboard.press('Escape');
    await shell.waitForFunction(() => document.getElementById('downloads-action').getAttribute('aria-expanded') === 'false');
    const savedPaths = [];
    for (let index = 0; index < 16; index++) {
      await site.getByRole('link', { name: 'Скачать файл', exact: true }).click();
      state = await waitState(shell, (s) => s.downloads.entries[0]?.phase === 'completed' && !savedPaths.includes(s.downloads.entries[0].path));
      savedPaths.push(state.downloads.entries[0].path);
    }
    assert.equal(state.downloads.entries.length, 15);
    for (const filename of savedPaths) assert.deepEqual(await fs.readFile(filename), payload, 'Old list records never delete their files');
    await folderButton.hover();
    await panel.locator('#files').hover();
    assert.equal(await panel.locator('#files li').count(), 15);
    assert.equal(await panel.locator('#files').evaluate((list) => list.scrollHeight > list.clientHeight), true);
    await panel.locator('#files').evaluate((list) => { list.scrollTop = list.scrollHeight; });
    assert.ok(await panel.locator('#files').evaluate((list) => list.scrollTop) > 0);
    await panel.locator('#files').evaluate((list) => { list.scrollTop = 0; });
    await panel.screenshot({ path: path.join(output, 'recent-downloads.png') });
    await panel.keyboard.press('Escape');
    await app.close(); app = undefined;
    shell = await launch();
    state = await shell.evaluate(() => window.maikoDesktop.state());
    assert.equal(state.downloads.entries.length, 15, 'Only the latest 15 successful downloads survive restart in the list');
    assert.ok(state.downloads.entries.every((entry) => entry.phase === 'completed'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 800, height: 600 }));
    const downloadsBounds = await shell.locator('.downloads-dock').boundingBox();
    const updateBounds = await shell.locator('#update-dock').boundingBox();
    assert.ok(downloadsBounds.x >= 0 && downloadsBounds.x + downloadsBounds.width <= updateBounds.x);
    assert.ok(downloadsBounds.y + downloadsBounds.height <= 42);
    await shell.screenshot({ path: path.join(output, 'toolbar.png') });
    console.log(`Electron downloads passed: names and bytes, session, duplicates, hover list, scrolling, reveal, folder click, one window, 15-record retention without file deletion, restart, cancel, errors and 800px layout. Screenshots: ${output}`);
  } finally {
    if (app) await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
