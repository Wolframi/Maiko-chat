const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end('{"desktopMediaHost":1}');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/desktop-runtime'
      ? '<!doctype html><title>Resize host</title><iframe data-maiko-desktop-ui src="/chat" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>'
      : '<!doctype html><title>Resize UI</title><body style="margin:0;overflow:hidden"><div id="fill" style="height:var(--app-height,100dvh);background:#293d51"></div><script>const sync=()=>document.documentElement.style.setProperty("--app-height",innerHeight+"px");sync();addEventListener("resize",()=>setTimeout(sync,250));</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = path.resolve(__dirname, '../test-output');
  const profile = path.join(output, `resize-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: profile, MAIKO_DESKTOP_URL: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120_000 });
    const shell = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setBounds({ x: 100, y: 100, width: 1000, height: 700 });
      win.setAlwaysOnTop(true); win.show(); win.focus();
    });
    await shell.waitForFunction(async () => (await window.maikoDesktop?.state())?.phase === 'ready', null, { polling: 100 });
    let host;
    for (let attempt = 0; attempt < 50 && !host; attempt++) {
      host = app.windows().find(page => page.url().startsWith(origin));
      if (!host) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(host, 'Persistent media document is loaded');
    const ui = await (await host.locator('iframe').elementHandle()).contentFrame();
    await ui.waitForFunction(() => !!document.querySelector('[data-maiko-layout]'));
    for (const page of [shell, host, ui]) {
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(12, 12, 14)', 'Each document has an opaque dark canvas');
    }
    assert.equal(await host.locator('iframe').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(12, 12, 14)');

    const identity = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find(view => view.webContents?.getURL().startsWith('http:'));
      globalThis.resizeTrace = [];
      const setBounds = view.setBounds.bind(view);
      view.setBounds = bounds => {
        globalThis.resizeTrace.push({ bounds, client: win.getContentSize() });
        setBounds(bounds);
      };
      return { handle: win.getNativeWindowHandle().readBigUInt64LE().toString(), pid: String(process.pid) };
    });
    await ui.evaluate(() => {
      window.resizeFrames = [];
      const sample = () => {
        window.resizeFrames.push({ width: innerWidth, height: innerHeight, fill: document.querySelector('#fill').getBoundingClientRect().height });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    if (process.platform === 'win32') {
      const helper = path.join(output, 'resize-drag.exe');
      await run(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
        ['/nologo', '/target:exe', '/platform:x64', `/out:${helper}`, path.join(__dirname, 'native-drag.cs')], { windowsHide: true });
      // Vertical growth/shrink from both edges and attempts beyond minHeight.
      for (const [x, y, dx, dy] of [['c', 's', 0, 180], ['c', 's', 0, -360], ['c', 'n', 0, -180], ['c', 'n', 0, 360], ['e', 's', 160, 120]]) {
        await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setBounds({ x: 100, y: 100, width: 1000, height: 700 }); win.focus(); });
        await ui.waitForFunction(() => innerWidth === 1000 && innerHeight === 658);
        await ui.evaluate(() => { window.resizeFrames = []; });
        await run(helper, [identity.handle, identity.pid, x, y, String(dx), String(dy)], { windowsHide: true });
        const frames = await ui.evaluate(() => window.resizeFrames);
        const heights = frames.map(frame => frame.height);
        assert.ok(new Set(heights).size >= 3, 'The UI paints during live native resizing');
        const direction = y === 'n' ? -Math.sign(dy) : Math.sign(dy);
        assert.ok(heights.every((height, index) => !index || direction * (height - heights[index - 1]) >= 0), `Height never bounces during ${y} resize: ${heights}`);
        assert.ok(frames.every(frame => Math.abs(frame.height - frame.fill) < 1), 'Delayed legacy viewport JS never leaves an unpainted strip');
      }
    } else {
      for (const height of [800, 650, 600]) await app.evaluate(({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0].setSize(1000, height), height);
    }
    const trace = await app.evaluate(() => globalThis.resizeTrace);
    assert.ok(trace.length > 0);
    for (const { bounds, client: [width, height] } of trace) {
      assert.deepEqual(bounds, { x: 0, y: 42, width, height: height - 42 }, 'Child viewport fills the committed client area below the toolbar');
    }
    console.log(`Live resize regression passed: ${trace.length} committed viewport sizes; vertical growth/shrink, minimum height, corner drag, persistent iframe and opaque canvases.`);
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
