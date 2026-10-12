const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const sharp = require('sharp');

async function windowState(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('file:'));
    return { bounds: win.getBounds(), minimized: win.isMinimized() };
  });
}
async function waitMinimized(app, minimized) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await windowState(app)).minimized === minimized) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Window minimized state did not become ${minimized}`);
}
async function main() {
  if (process.platform !== 'win32') { console.log('Windows animation regression skipped on this platform.'); return; }
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Window controls test</title><body style="background:#0c0c0e">Window controls test</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const output = path.resolve(__dirname, '../test-output');
  const profile = path.join(output, `window-animations-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true });
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: profile, MAIKO_DESKTOP_URL: `http://127.0.0.1:${server.address().port}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.MAIKO_TEST_EXECUTABLE || require('electron');
  const args = process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')];
  let app;
  try {
    app = await electron.launch({ executablePath, args, env, timeout: 120_000 });
    const shell = await app.firstWindow();
    await shell.waitForFunction(async () => !!window.maikoDesktop && (await window.maikoDesktop.state()).phase === 'ready', null, { polling: 100, timeout: 30_000 });
    const identity = await app.evaluate(({ BrowserWindow }) => ({ handle: BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(), pid: String(process.pid) }));
    const helper = path.resolve(__dirname, '../native/window-animations.exe');
    const captureHelper = path.join(output, 'native-corners.exe');
    execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/platform:x64', '/r:System.Drawing.dll', `/out:${captureHelper}`, path.join(__dirname, 'native-corners.cs')], { windowsHide: true });
    const inspect = () => JSON.parse(execFileSync(helper, [identity.handle, identity.pid, 'inspect'], { windowsHide: true }).toString());
    const expectedStyle = { caption: true, thickFrame: true, nativeFrame: true };
    assert.deepEqual(inspect(), expectedStyle, 'Windows owns the resize frame and native transitions');
    assert.throws(() => execFileSync(helper, [identity.handle, '0', 'enable'], { windowsHide: true, stdio: 'pipe' }), 'Helper rejects an invalid process');
    assert.throws(() => execFileSync(helper, [identity.handle, String(process.pid), 'enable'], { windowsHide: true, stdio: 'pipe' }), 'Helper rejects a window owned by another process');
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      // A known backdrop distinguishes actual OS transparency from the white
      // native backing that capturePage (renderer-only) cannot see.
      const backdrop = new BrowserWindow({ x: 80, y: 80, width: 1040, height: 740,
        frame: false, backgroundColor: '#00ffff', show: false });
      await backdrop.loadURL('data:text/html,<body style="margin:0;background:cyan">');
      backdrop.show();
      win.setBounds({ x: 100, y: 100, width: 1000, height: 700 });
      win.show();
      win.focus();
    });
    await shell.waitForFunction(() => innerWidth === 1000 && innerHeight === 700, null, { polling: 100 });
    const normalBounds = (await windowState(app)).bounds;
    // Exercise the real custom minimize button and native restore in both states.
    for (const maximized of [false, true]) {
      if (maximized) await shell.getByRole('button', { name: 'Развернуть', exact: true }).click();
      const before = (await windowState(app)).bounds;
      for (let cycle = 0; cycle < 2; cycle++) {
        await shell.getByRole('button', { name: 'Свернуть', exact: true }).click();
        await waitMinimized(app, true);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('file:')).restore());
        await waitMinimized(app, false);
        await shell.waitForFunction(async (maximized) => (await window.maikoDesktop.state()).maximized === maximized, maximized, { polling: 100 });
        assert.deepEqual((await windowState(app)).bounds, before, 'Restoring keeps the previous bounds');
        assert.deepEqual(inspect(), expectedStyle, 'Transitions and transparent frame survive minimize/restore');
      }
    }
    await shell.getByRole('button', { name: 'Восстановить', exact: true }).click();
    assert.deepEqual((await windowState(app)).bounds, normalBounds);
    // Fullscreen must not erase the caption flag or change the restored window.
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('file:'));
      for (const fullscreen of [true, false]) {
        const changed = new Promise((resolve) => win.once(fullscreen ? 'enter-full-screen' : 'leave-full-screen', resolve));
        win.setFullScreen(fullscreen);
        await changed;
      }
    });
    assert.deepEqual(inspect(), expectedStyle);
    assert.deepEqual((await windowState(app)).bounds, normalBounds);
    // Keep the owned test surface above other windows during the OS-only check.
    // A foreground browser otherwise makes CopyFromScreen inspect its pixels.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('file:'));
      win.setAlwaysOnTop(true); win.show(); win.moveTop();
    });
    await shell.waitForTimeout(500);
    const nativeFile = path.join(output, 'native-square-corners.png');
    execFileSync(captureHelper, [identity.handle, identity.pid, nativeFile], { windowsHide: true });
    const physical = await sharp(nativeFile).raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of [[0, 0], [physical.info.width - 1, 0], [0, physical.info.height - 1], [physical.info.width - 1, physical.info.height - 1]]) {
      const index = (y * physical.info.width + x) * physical.info.channels;
      const corner = Array.from(physical.data.subarray(index, index + 3));
      assert.notDeepEqual(corner, [0, 255, 255], 'Every visible corner is drawn; no rounded clipping exposes the backdrop');
      assert.notDeepEqual(corner, [255, 255, 255], 'The native frame has no white corner backing');
    }
    const png = Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('file:')).capturePage()).toPNG().toString('base64')), 'base64');
    await fs.writeFile(path.join(output, 'window-after-restore.png'), png);
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]]) {
      assert.equal(data[(y * info.width + x) * 4 + 3], 255, 'Square opaque corners survive minimize, maximize and fullscreen');
    }
    await shell.getByRole('button', { name: 'Свернуть', exact: true }).click();
    await waitMinimized(app, true);
    await app.close(); app = undefined;
    const saved = JSON.parse(await fs.readFile(path.join(profile, 'desktop-settings.json'), 'utf8'));
    assert.deepEqual(saved.bounds, normalBounds, 'Close saves the correct bounds after minimizing');
    assert.equal(saved.maximized, false);
    app = await electron.launch({ executablePath, args, env, timeout: 120_000 });
    const reopened = await app.firstWindow();
    await reopened.waitForFunction(() => !!window.maikoDesktop, null, { polling: 100 });
    assert.deepEqual((await windowState(app)).bounds, normalBounds, 'Relaunch restores the same window geometry');
    console.log('Window animation regression passed: native caption flag, owner validation, minimize button, repeated normal/maximized restore, fullscreen, square corners, saved bounds and relaunch.');
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
