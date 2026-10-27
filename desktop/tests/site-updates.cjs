const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

async function main() {
  // Exercise the real preload, trusted IPC handler, native window events and
  // dock without a deployed site or an actual server update.
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body>Update fixture</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/desktop-runtime`;
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_URL: url,
    MAIKO_DESKTOP_USER_DATA: path.resolve(__dirname, `../test-output/site-updates-${Date.now()}`) };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env });
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => document.body.dataset.phase === 'ready');
    const site = app.windows().find(page => page.url() === url);
    assert.ok(site, 'The trusted media document loaded');
    const report = phase => site.evaluate(phase => window.maikoMediaShell.siteUpdate(phase), phase);
    const wait = ms => app.evaluate(async (_electron, ms) => new Promise(resolve => setTimeout(resolve, ms)), ms);
    const visiblePhase = async (phase, timeout = 10_000) => {
      await shell.waitForFunction(phase => document.querySelector('#site-update-dock').dataset.phase === phase, phase, { timeout });
      if (phase === 'idle') await shell.locator('#site-update-dock').waitFor({ state: 'hidden', timeout });
      assert.equal(await shell.locator('#site-update-dock').isVisible(), phase !== 'idle');
    };
    const windowAction = action => app.evaluate(async ({ BrowserWindow }, action) => {
      const win = BrowserWindow.getAllWindows()[0];
      win[action]();
      // Windows may omit an event when the requested state is already true.
      // Check the resulting native state and bound the wait instead of
      // hanging forever on a one-shot event listener.
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        const reached = action === 'minimize' ? win.isMinimized()
          : action === 'restore' ? !win.isMinimized() && win.isVisible()
            : action === 'hide' ? !win.isVisible() : win.isVisible();
        if (reached) return;
      }
      throw new Error(`Window did not ${action}`);
    }, action);

    // The testing window starts hidden: background completion must retain the
    // entire six seconds, even after duplicate ready reports.
    await report('loading');
    await report('ready');
    await wait(6500);
    await report('ready');
    await windowAction('show');
    await visiblePhase('ready');
    assert.equal(await shell.locator('#site-update-label').textContent(), 'Сайт обновлён');
    await wait(5000);
    await visiblePhase('ready');
    await visiblePhase('idle');

    // Minimize while loading, then complete the update in the background.
    await report('loading');
    await visiblePhase('loading');
    await windowAction('minimize');
    await report('ready');
    await wait(6500);
    await windowAction('restore');
    await visiblePhase('ready');
    await shell.screenshot({ path: path.resolve(__dirname, '../test-output/site-update-restored.png') });
    await wait(2500);

    // The remainder must survive multiple minimize/hide cycles. It must not
    // expire while hidden or restart at six seconds when restored.
    await windowAction('minimize');
    await wait(6500);
    await report('ready');
    await windowAction('restore');
    await visiblePhase('ready');
    await wait(500);
    await windowAction('hide');
    await wait(1000);
    await windowAction('show');
    await visiblePhase('ready');
    await visiblePhase('idle', 4500);
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).siteUpdatePhase, 'idle');

    // Restoring an unfinished update keeps the loading text and spinner.
    await report('loading');
    await windowAction('minimize');
    await wait(500);
    await windowAction('restore');
    await visiblePhase('loading');
    assert.equal(await shell.locator('#site-update-label').textContent(), 'Сайт обновляется…');
    await report('ready');
    await wait(500);
    await report('loading');
    await report('error');
    await wait(6500);
    await visiblePhase('error');
    assert.equal(await shell.locator('#site-update-label').textContent(), 'Не удалось обновить сайт');

    console.log('Site update UI passed: hidden/minimized completion, remaining visible time, repeated ready, multiple pause/resume cycles, loading restore and error cancel the old countdown.');
  } finally {
    await app?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
