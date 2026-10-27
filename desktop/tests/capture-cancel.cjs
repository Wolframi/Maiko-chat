// Native picker cancellation; no source is shared and no frames are saved.
const { _electron: electron } = require('playwright');
const { build } = require('esbuild');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

async function main() {
  const bundle = await build({ entryPoints: [path.resolve(__dirname, '../../site/src/lib/webrtcMedia.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'captureTest' });
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', request.url === '/api/health' ? 'application/json' : 'text/html');
    response.end(request.url === '/api/health' ? '{"ok":true}' : '<title>Picker cancellation test</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_URL: origin,
    MAIKO_DESKTOP_USER_DATA: path.resolve(__dirname, '../test-output/capture-cancel-' + Date.now()) };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env, timeout: 60000 });
    const shell = await app.firstWindow();
    await shell.waitForFunction(async () => (await window.maikoDesktop.state()).phase === 'ready', null,
      { polling: 100, timeout: 60000 });
    let site;
    // The shell can report ready before CDP attaches the WebContentsView.
    for (let i = 0; i < 300 && !site; i++) {
      site = app.windows().find(page => page.url().startsWith(origin));
      if (!site) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(site);
    console.log('Electron capture fixture ready.');
    await site.addScriptTag({ content: bundle.outputFiles[0].text });
    for (const method of ['button', 'escape', 'window']) {
      const ready = app.waitForEvent('window', { predicate: page => page !== site && page !== shell, timeout: 30000 });
      const request = site.evaluate(async () => {
        try { await window.captureTest.captureScreenShare(); return { unexpected: true }; }
        catch (error) { return { name: error.name, cancelled: window.captureTest.isScreenCaptureCancelled(error) }; }
      });
      const picker = await ready;
      await picker.getByRole('button', { name: 'Отмена', exact: true }).waitFor();
      if (method === 'button') {
        await picker.getByRole('button', { name: 'Отмена', exact: true }).click({ noWaitAfter: true }).catch(error => {
          if (!picker.isClosed()) throw error;
        });
      } else if (method === 'escape') {
        await picker.keyboard.press('Escape').catch(error => { if (!picker.isClosed()) throw error; });
      } else {
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows().find(window => window.getTitle().includes('Демонстрация экрана')).close();
        });
      }
      assert.deepEqual(await request, { name: 'AbortError', cancelled: true }, method);
      assert.equal(await site.evaluate(() => window.maikoScreenAudio.takePolicy()), null);
      console.log(`Picker ${method} cancellation passed; another picker can open.`);
    }
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
