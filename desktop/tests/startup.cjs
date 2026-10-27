const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  let pending;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/app') pending = res;
    else if (req.url === '/desktop-runtime') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><head><meta name="maiko-desktop-startup" content="local-model"></head><body>Waiting for UI</body>');
    }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = path.resolve(__dirname, '../test-output');
  await fs.mkdir(output, { recursive: true });
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1',
    MAIKO_DESKTOP_USER_DATA: path.join(output, `startup-${Date.now()}`),
    MAIKO_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/app` };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env });
    const shell = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setBounds({ x: 100, y: 100, width: 1000, height: 700 });
      win.show();
    });
    await shell.waitForFunction(() => document.querySelector('#startup-model')?.dataset.state === 'ready');
    const startedAt = await shell.locator('#startup-model').getAttribute('data-started-at');
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).phase, 'loading');
    assert.equal(await shell.locator('#connection-screen').isVisible(), false);
    assert.equal(await shell.locator('#loader, .app-icon, .eyebrow').count(), 0, 'No separate desktop loading card');
    assert.equal(await shell.getByText('Почти на месте').count(), 0);
    for (let attempt = 0; !pending && attempt < 40; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(pending, 'The site starts loading alongside the local animation');
    pending.setHeader('content-type', 'text/html');
    pending.end('<!doctype html><title>Ready</title><body>Ready</body>');
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).phase, 'loading', 'A fast site cannot cut the model animation short');
    assert.ok(!requests.some(url => /models|maiko.*bin/.test(url)), 'The model makes no network requests');
    await shell.waitForFunction(() => document.body.dataset.phase === 'ready');
    const playedMs = await shell.evaluate(start => Date.now() - Number(start), startedAt);
    assert.ok(playedMs >= 2900, `The model should play for three seconds, got ${playedMs} ms`);
    assert.ok(playedMs < 4500, `A ready site should not wait for the old five-second intro, got ${playedMs} ms`);
    assert.equal(await shell.locator('#startup-model').isVisible(), false);
    // Keep model validation outside the timed fast-start path.
    await assert.rejects(shell.evaluate(() => window.maikoDesktop.startupModel('../config.json')), /Неизвестная анимация/);
    for (const intro of ['hiphop', 'samba']) {
      const header = await shell.evaluate(async intro => {
        const bytes = await window.maikoDesktop.startupModel(intro);
        return [...bytes.slice(0, 4)];
      }, intro);
      assert.deepEqual(header, [77, 75, 65, 78], `${intro} is available from the local package`);
    }
    const site = app.windows().find(page => /^http:/.test(page.url()));
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(view => /^http:/.test(view.webContents?.getURL()));
      return view.webContents.loadURL(new URL('/desktop-runtime', view.webContents.getURL()).href);
    });
    await shell.waitForFunction(() => document.querySelector('#startup-model')?.dataset.state === 'ready' && document.body.dataset.phase === 'loading');
    assert.equal(await shell.locator('#startup-model').isVisible(), true, 'Keep the one local animation while the UI initializes');
    // Hold the UI readiness signal while checking the mascot, so screenshot
    // capture cannot race the shorter intro finishing on a fast machine.
    await shell.evaluate(() => new Promise(resolve => {
      const started = performance.now();
      const frame = () => performance.now() - started >= 1500 ? resolve() : requestAnimationFrame(frame);
      requestAnimationFrame(frame);
    }));
    const png = await shell.locator('#startup-model').screenshot({ path: path.join(output, 'startup-model.png') });
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let bright = 0;
    for (let i = 0; i < data.length; i += info.channels) if (Math.max(data[i], data[i + 1], data[i + 2]) > 60) bright++;
    assert.ok(bright > 100, 'The local model paints visible particles while the UI readiness signal is pending');
    // A slow interface refresh used to freeze on the last pose at 7.1s.
    // Wait for actual rendered time, since a hidden window or a slow GPU may
    // pause animation time independently of the wall clock.
    await shell.waitForFunction(() => Number(document.querySelector('#startup-model').dataset.elapsed) > 8, null, { timeout: 30000 });
    const lateFrame = await shell.locator('#startup-model').screenshot();
    const lateElapsed = await shell.locator('#startup-model').getAttribute('data-elapsed');
    await shell.waitForFunction(elapsed => Number(document.querySelector('#startup-model').dataset.elapsed) > Number(elapsed) + .5, lateElapsed);
    const nextFrame = await shell.locator('#startup-model').screenshot({ path: path.join(output, 'startup-model-long-refresh.png') });
    assert.notDeepEqual(lateFrame, nextFrame, 'The model keeps moving after eight seconds of a pending refresh');
    const refreshReadyAt = Date.now();
    await site.evaluate(() => window.maikoMediaShell.siteUpdate('ready'));
    await shell.waitForFunction(() => document.body.dataset.phase === 'ready');
    assert.equal(await shell.locator('#startup-model').isVisible(), false, 'Switch directly to the ready UI after its signal');
    assert.ok(Date.now() - refreshReadyAt < 2000, 'Later interface refreshes do not repeat the three-second startup wait');
    // Retry / error transitions must not leave the spinner card or GPU loop up.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('desktop:state-changed', {
      phase: 'error', message: 'Нет подключения', maximized: false,
    }));
    await shell.locator('#connection-screen').waitFor({ state: 'visible' });
    assert.equal(await shell.locator('#startup-model').isVisible(), false);
    assert.equal(await shell.getByRole('button', { name: 'Повторить', exact: true }).isVisible(), true);
    console.log(`Startup passed: ${playedMs} ms of local animation despite a fast site, parallel loading, no repeated refresh delay, both model variants, error transitions and scoped IPC.`);
    await app.close(); app = null; pending = null;
    env.MAIKO_DESKTOP_USER_DATA += '-reduced';
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env });
    const reducedShell = await app.firstWindow();
    await reducedShell.emulateMedia({ reducedMotion: 'reduce' });
    await reducedShell.waitForFunction(() => document.querySelector('#startup-model')?.dataset.state === 'ready');
    for (let attempt = 0; !pending && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(pending);
    const reducedReadyAt = Date.now();
    pending.setHeader('content-type', 'text/html'); pending.end('<!doctype html><body>Ready with reduced motion</body>');
    await reducedShell.waitForFunction(() => document.body.dataset.phase === 'ready');
    assert.ok(Date.now() - reducedReadyAt < 2000, 'Reduced-motion users can enter the ready site without the three-second wait');
    console.log('Reduced-motion startup passed: no mandatory animation wait.');
  } finally {
    pending?.end();
    await app?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
