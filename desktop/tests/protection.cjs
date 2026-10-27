const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

async function main() {
  const executablePath = process.env.MAIKO_TEST_EXECUTABLE || path.resolve(__dirname, '../test-output/protected-release/win-unpacked/Maiko.exe');
  const output = path.resolve(__dirname, '../test-output/protection-' + Date.now());
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true, service: 'pulse', desktopMediaHost: 1 }));
    }
    if (req.url === '/desktop-runtime') return res.end('<!doctype html><title>Protected media host</title><iframe data-maiko-desktop-ui src="/app"></iframe>');
    res.end('<!doctype html><title>Protected UI fixture</title><body style="background:#141416;color:white">Protected application fixture</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_URL: url,
    MAIKO_DESKTOP_USER_DATA: output };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const errors = [];
  try {
    app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
    app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => window.maikoDesktop && document.body.dataset.phase === 'ready', null, { timeout: 30_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const result = await shell.evaluate(() => ({
      state: document.body.dataset.phase,
      classes: document.querySelector('body > div').className,
      height: document.querySelector('#titlebar').getBoundingClientRect().height,
      status: document.getElementById('status').textContent,
      hasNode: typeof window.require,
    }));
    assert.match(result.classes, /^c[0-9a-f]{12}$/);
    assert.equal(result.height, 41, 'Renamed CSS still lays out the toolbar');
    assert.equal(result.hasNode, 'undefined');
    assert.equal(result.state, 'ready');
    assert.ok(result.status.length > 0, 'Obfuscated shell and status animation run together');

    const preferences = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => /^https?:/.test(contents.getURL())).map(contents => {
      const prefs = contents.getLastWebPreferences();
      return { sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation };
    }));
    assert.ok(preferences.length);
    for (const prefs of preferences) assert.deepEqual(prefs, { sandbox: true, nodeIntegration: false, contextIsolation: true });
    const site = app.windows().find(page => page.url() === url + '/desktop-runtime');
    assert.ok(site);
    assert.equal(await site.evaluate(() => typeof window.maikoScreenAudio.takePolicy), 'function');
    await site.locator('iframe[data-maiko-desktop-ui]').waitFor();
    const helpers = await app.evaluate(async ({ webContents }) => {
      const site = webContents.getAllWebContents().find(contents => /^http:/.test(contents.getURL()));
      for (let i = 0; i < 50; i++) {
        const result = await site.executeJavaScriptInIsolatedWorld(1001, [{ code: `Boolean(document.querySelector('iframe')?.contentWindow.maikoDownloadRingsInitialized)` }]);
        if (result) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    });
    assert.equal(helpers, true, 'Obfuscated download helper receives the isolated bridge inside the iframe');
    await shell.getByRole('button', { name: 'Развернуть', exact: true }).click();
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).maximized, true);
    assert.equal(await shell.evaluate(() => getComputedStyle(document.querySelector('body > div')).borderTopColor), 'rgba(0, 0, 0, 0)');

    const panelOpened = app.waitForEvent('window', { predicate: page => page.url().endsWith('/downloads-panel.html') });
    await shell.evaluate(() => window.maikoDesktop.downloadsPanel(true, { x: 400, width: 40 }));
    const panel = await panelOpened;
    await panel.getByText('Скачанные файлы появятся здесь.').waitFor();
    assert.equal(await panel.evaluate(() => typeof window.maikoDownloads.state), 'function');
    await shell.evaluate(() => window.maikoDesktop.downloadsPanel(false));
    const pickerOpened = app.waitForEvent('window', { predicate: page => page.url().endsWith('/capture.html') });
    const capture = site.evaluate(() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(
      stream => { stream.getTracks().forEach(track => track.stop()); return 'unexpected capture'; }, error => error.name));
    const picker = await pickerOpened;
    await picker.locator('#sources button').first().waitFor();
    assert.equal(await picker.locator('#sources button').first().evaluate(button => getComputedStyle(button).borderTopWidth), '2px');
    await picker.getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await capture, 'AbortError');
    await shell.screenshot({ path: path.join(output, 'protected-shell.png') });
    assert.deepEqual(errors, []);
    console.log('Protected packaged app passed: bytecode launch, renamed CSS, sandbox preloads, window controls, persistent iframe helpers and downloads panel.');
    console.log('Screenshot: ' + path.join(output, 'protected-shell.png'));
  } finally {
    await app?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
