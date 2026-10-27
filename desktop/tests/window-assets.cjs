const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function main() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url, method: req.method, cookie: req.headers.cookie });
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Asset test</title><body style="background:#0c0c0e;margin:0;overflow:hidden"><div id="fill" style="height:var(--app-height,100dvh);background:#293d51">Maiko asset test</div><script>const update=()=>document.documentElement.style.setProperty("--app-height",innerHeight+"px");update();addEventListener("resize",()=>setTimeout(update,250));</script>');
    }
    else if (req.url === '/api/echo') {
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'maiko-test-session=from-server; HttpOnly; Path=/; SameSite=Lax');
      res.end(JSON.stringify({ body, cookie: req.headers.cookie }));
    } else if (req.url === '/api/redirect') {
      res.writeHead(307, { location: '/api/echo' }); res.end();
    } else { res.writeHead(404); res.end('Remote asset absent'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const output = path.resolve(__dirname, '../test-output');
  const profile = path.join(output, `window-assets-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true });
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: profile, MAIKO_DESKTOP_URL: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'), args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120000 });
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => !!window.maikoDesktop, null, { polling: 100 });
    for (let i = 0; i < 600; i++) {
      const state = await shell.evaluate(() => window.maikoDesktop.state());
      if (state.phase === 'error') throw new Error(state.message);
      if (state.phase === 'ready') break;
      if (i === 599) throw new Error('Site did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let site;
    for (let i = 0; i < 50 && !site; i++) {
      site = app.windows().find((page) => page.url().startsWith(origin));
      if (!site) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(site, `Site page missing: ${app.windows().map((page) => page.url()).join(', ')}`);
    assert.equal(await shell.locator('#titlebar #status').textContent(), 'Подключено', 'Connection status belongs to the top desktop titlebar');
    const labels = await site.evaluate(() => {
      const idle = document.createElement('section'); idle.className = 'room room--idle';
      idle.innerHTML = '<header class="room__header"><h2 class="room__title">подключено</h2></header>';
      const active = document.createElement('section'); active.className = 'room';
      active.innerHTML = '<header class="room__header"><h2 class="room__title">Тема группы</h2></header>';
      const banner = document.createElement('div'); banner.className = 'reconnect-banner is-ok'; banner.textContent = 'подключено';
      document.body.append(idle, active, banner);
      const result = [idle.querySelector('h2'), active.querySelector('h2'), banner].map((element) => getComputedStyle(element).display);
      idle.remove(); active.remove(); banner.remove();
      return result;
    });
    assert.equal(labels[0], 'none', 'Messenger idle header does not repeat the desktop status');
    assert.notEqual(labels[1], 'none', 'Active chat topic remains visible');
    assert.equal(labels[2], 'none', 'No duplicate reconnect label in the messenger');
    const controls = await shell.locator('.window-actions').boundingBox();
    assert.ok(controls.x + controls.width >= (await shell.evaluate(() => innerWidth)) - 2, 'Controls stay at the right edge');
    if (process.platform === 'win32') {
      const helper = path.join(output, 'native-icons.exe');
      await run(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
        ['/nologo', '/target:exe', '/platform:x64', '/r:System.Drawing.dll', `/out:${helper}`, path.join(__dirname, 'native-icons.cs')], { windowsHide: true });
      const identity = await app.evaluate(({ BrowserWindow }) => ({ handle: BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(), pid: String(process.pid) }));
      const prefix = path.join(profile, 'window-icon');
      await run(helper, [identity.handle, identity.pid, prefix], { windowsHide: true });
      const prefixes = [prefix];
      if (process.env.MAIKO_TEST_EXECUTABLE) {
        const exePrefix = path.join(profile, 'exe-icon');
        await run(helper, ['exe', process.env.MAIKO_TEST_EXECUTABLE, exePrefix], { windowsHide: true });
        prefixes.push(exePrefix);
      }
      for (const prefix of prefixes) for (const size of ['large', 'small']) {
        const { data, info } = await sharp(`${prefix}-${size}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const expected = await sharp(path.join(__dirname, '../assets/icon.png')).resize(info.width, info.height).ensureAlpha().raw().toBuffer();
        let error = 0, opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 100) opaque++;
          for (let c = 0; c < 3; c++) error += Math.abs(data[i+c] * data[i+3] / 255 - expected[i+c] * expected[i+3] / 255);
        }
        assert.ok(opaque > info.width * info.height / 4 && error / (info.width * info.height * 3) < 35, `Windows ${size} icon contains the Maiko logo`);
      }
    }
    const files = ['/maiko/maiko-intro-v11.webm?v=11', '/models/maiko-atoms.bin', '/audio/dtln-0.1.1/runtime.wasm', '/audio/dtln-0.1.1/worker.js'];
    const manifest = require('../bundled-assets/manifest.json');
    for (const extension of ['.js', '.css', '.woff2']) {
      const frontend = Object.keys(manifest).find((url) => url.startsWith('/_next/static/') && url.endsWith(extension));
      assert.ok(frontend, `Bundled frontend includes ${extension}`);
      files.push(frontend);
    }
    const assets = await site.evaluate(async (files) => Promise.all(files.map(async (file) => {
      const response = await fetch(file, { headers: { range: 'bytes=0-31' } });
      return { status: response.status, source: response.headers.get('x-maiko-asset'), length: (await response.arrayBuffer()).byteLength };
    })), files);
    assert.deepEqual(assets, files.map(() => ({ status: 206, source: 'bundled', length: 32 })));
    assert.ok(!requests.some((req) => files.some((file) => req.url === file)), 'Bundled resources never hit the server');
    const video = await site.evaluate(async () => {
      const video = document.createElement('video'); video.muted = true; video.preload = 'auto';
      // Keep this decoding probe in the viewport, then remove it before testing
      // resize pixels. Chromium may defer data for media below the viewport.
      video.style.cssText = 'position:fixed;top:60px;left:30px;width:64px;height:64px';
      document.body.append(video);
      let timer;
      const loaded = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Local video decoding timed out')), 15_000);
        video.onloadeddata = () => resolve({ width: video.videoWidth, duration: video.duration });
        video.onerror = () => reject(new Error('Local video failed'));
      });
      video.src = '/maiko/maiko-intro-v11.webm?v=11';
      try { return await loaded; } finally { clearTimeout(timer); video.remove(); }
    });
    assert.ok(video.width > 0 && video.duration > 0, 'Local animation is decoded');
    const api = await site.evaluate(async () => {
      document.cookie = 'maiko-test-cookie=ok; path=/';
      return fetch('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"test":true}' }).then((response) => response.json());
    });
    assert.deepEqual(api, { body: '{"test":true}', cookie: 'maiko-test-cookie=ok' });
    const redirect = await site.evaluate(() => fetch('/api/redirect', { method: 'POST', body: 'redirected body' }).then((response) => response.json()));
    assert.equal(redirect.body, 'redirected body');
    assert.ok(redirect.cookie.includes('maiko-test-session=from-server'), 'Server login cookies persist across requests');
    assert.equal(await site.evaluate(() => fetch('/uploads/not-bundled.png').then((response) => response.status)), 404);
    assert.ok(requests.some((request) => request.url === '/uploads/not-bundled.png'));

    await shell.evaluate(() => { window.resizeStateUpdates = 0; window.maikoDesktop.onState(() => window.resizeStateUpdates++); });
    await site.evaluate(() => {
      window.resizeFrames = [];
      function frame() {
        const height = document.getElementById('fill').getBoundingClientRect().height;
        window.resizeFrames.push({ height, viewport: innerHeight });
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    assert.equal(await shell.locator('.resize-grip').count(), 0, 'No manual resize hit boxes remain');
    assert.equal(await shell.evaluate(() => 'resizeStart' in window.maikoDesktop), false, 'No manual resize IPC remains');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isResizable()), true);
    for (const [width, height] of [[1000, 700], [900, 650], [1100, 800], [1000, 700]]) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setBounds({ x: 100, y: 100, width, height }), [width, height]);
      await shell.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, [width, height]);
      await site.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height - 42, [width, height]);
      await shell.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    assert.equal(await shell.evaluate(() => window.resizeStateUpdates), 0, 'Resizing does not rewrite the titlebar or publish unchanged state');
    const frames = await site.evaluate(() => window.resizeFrames);
    assert.ok(new Set(frames.map((frame) => frame.viewport)).size >= 3, 'Recorded frames while the viewport changed');
    assert.ok(frames.every((frame) => Math.abs(frame.height - frame.viewport) < 1), 'Every rendered frame fills the viewport even while legacy JS height lags');
    if (process.platform === 'win32') {
      const helper = path.join(output, 'native-resize.exe');
      await run(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
        ['/nologo', '/target:exe', '/platform:x64', '/r:System.Drawing.dll', `/out:${helper}`, path.join(__dirname, 'native-resize.cs')], { windowsHide: true });
      const dragHelper = path.join(output, 'native-drag.exe');
      await run(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
        ['/nologo', '/target:exe', '/platform:x64', `/out:${dragHelper}`, path.join(__dirname, 'native-drag.cs')], { windowsHide: true });
      const identity = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setAlwaysOnTop(true); win.setBounds({ x: 100, y: 100, width: 1000, height: 700 }); win.show(); win.moveTop();
        return { handle: win.getNativeWindowHandle().readBigUInt64LE().toString(), pid: String(process.pid) };
      });
      await site.waitForFunction(() => innerWidth === 1000 && innerHeight === 658);
      await site.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // The native show transition blends with the backdrop before resizing
      // starts. Sample live resize after that separate animation has finished.
      await shell.waitForTimeout(500);
      const sampler = spawn(helper, [identity.handle, identity.pid], { windowsHide: true });
      let report = '', error = '';
      const ready = new Promise((resolve, reject) => {
        sampler.stdout.on('data', (chunk) => { report += chunk; if (report.includes('READY')) resolve(); });
        sampler.once('error', reject);
        sampler.once('exit', (code) => { if (!report.includes('READY')) reject(new Error(`Sampler exited before ready: ${code}`)); });
      });
      sampler.stderr.on('data', (chunk) => { error += chunk; });
      const completed = new Promise((resolve, reject) => {
        sampler.once('error', reject);
        sampler.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error || `Sampler exited: ${code}`)));
      });
      await ready;
      try {
        await run(dragHelper, [identity.handle, identity.pid, 'e', 's', '380', '190'], { windowsHide: true });
        await completed;
        const pixels = JSON.parse(report.trim().split('\n').at(-1));
        assert.equal(pixels.samples, 400);
        assert.equal(pixels.black, 0, `No black resize bands in native composition: ${report}`);
        assert.equal(pixels.other, 0, `No exposed desktop/white bands: ${report}`);
        console.log(`Live resize: ${pixels.samples} OS-composited samples, no black or exposed bands.`);
      } finally { sampler.kill(); }
      const hitTests = { w: 10, e: 11, n: 12, nw: 13, ne: 14, s: 15, sw: 16, se: 17 };
      for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setBounds({ x: 100, y: 100, width: 1000, height: 700 }); win.show(); win.focus(); win.moveTop(); });
        const contentSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
        await shell.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, contentSize);
        const x = edge.includes('w') ? 'w' : edge.includes('e') ? 'e' : 'c';
        const y = edge.includes('n') ? 'n' : edge.includes('s') ? 's' : 'c';
        const dx = edge.includes('w') ? 60 : edge.includes('e') ? -60 : 0;
        const dy = edge.includes('n') ? 40 : edge.includes('s') ? -40 : 0;
        const drag = await run(dragHelper, [identity.handle, identity.pid, x, y, String(dx), String(dy)], { windowsHide: true });
        assert.equal(JSON.parse(drag.stdout).hit, hitTests[edge], `Windows owns the native ${edge} resize boundary`);
        const expected = { x: edge.includes('w') ? 160 : 100, y: edge.includes('n') ? 140 : 100, width: /[ew]/.test(edge) ? 940 : 1000, height: /[ns]/.test(edge) ? 660 : 700 };
        const actual = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
        assert.deepEqual(actual, expected, `Native drag from ${edge} anchors the opposite edge; hit test ${drag.stdout.trim()}`);
      }
    }
    await shell.getByRole('button', { name: 'Развернуть', exact: true }).click();
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).maximized, true);
    await shell.getByRole('button', { name: 'Восстановить', exact: true }).click();
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).maximized, false);
    // Capture the rectangular shell; nested native views are checked separately.
    const png = Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')), 'base64');
    await fs.writeFile(path.join(output, 'square-corners.png'), png);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]]) {
      assert.equal(data[(y * info.width + x) * 4 + 3], 255, 'Every outer corner is square and opaque');
    }
    const geometry = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find(view => view.webContents?.getURL().startsWith('http:'));
      return { bounds: view.getBounds(), size: win.getContentSize() };
    });
    assert.deepEqual(geometry.bounds, { x: 0, y: 42, width: geometry.size[0], height: geometry.size[1] - 42 }, 'No side or bottom gutter exposes the shell');
    const sitePng = await site.screenshot({ path: path.join(output, 'site-no-gutters.png') });
    const pixels = await sharp(sitePng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of [[0, 100], [pixels.info.width - 1, 100], [pixels.info.width / 2 | 0, pixels.info.height - 1]]) {
      const offset = (y * pixels.info.width + x) * pixels.info.channels;
      assert.deepEqual([...pixels.data.subarray(offset, offset + 3)], [41, 61, 81], 'Fixture fills both side edges and the bottom');
    }
    await app.close(); app = undefined;
    console.log('Window/assets regression passed: all 8 native resize boundaries, anchored opposite edges, square opaque corners, no side/bottom gutters, local video/model/WASM/worker, remote POST cookies/body and uploads.');
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
