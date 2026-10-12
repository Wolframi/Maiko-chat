const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fixtureServer, checkChat } = require('./viewport.cjs');
const run = promisify(execFile);

async function main() {
  if (process.platform !== 'win32') return;
  const zones = ['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
  if (!process.argv[2]) {
    // Start each gesture from a normal window. Changing bounds alone doesn't
    // reset Windows' remembered Snap/restore placement for the next drag.
    for (const zone of zones) {
      const result = await run(process.execPath, [__filename, zone], { windowsHide: true });
      process.stdout.write(result.stdout);
    }
    return;
  }
  const server = await fixtureServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const output = path.resolve(__dirname, '../test-output');
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: path.join(output, `snap-${Date.now()}`), MAIKO_DESKTOP_URL: origin + '/updated' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120_000 });
    const shell = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
    await shell.waitForFunction(async () => (await window.maikoDesktop?.state())?.phase === 'ready', null, { polling: 100 });
    let site;
    for (let attempt = 0; attempt < 50 && !site; attempt++) {
      site = app.windows().find(page => page.url().startsWith(origin));
      if (!site) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(site);
    const helper = path.join(output, 'snap-drag.exe');
    await run(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/platform:x64', `/out:${helper}`, path.join(__dirname, 'native-drag.cs')], { windowsHide: true });
    const keys = path.join(output, 'snap-key.exe');
    await run(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/platform:x64', `/out:${keys}`, path.join(__dirname, 'native-snap.cs')], { windowsHide: true });
    const keyIdentity = await app.evaluate(({ BrowserWindow }) => ({ handle: BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(), pid: String(process.pid) }));
    await run(keys, [keyIdentity.handle, keyIdentity.pid, 'left'], { windowsHide: true });
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].snapped), true, 'Win+Left remains supported');
    await run(keys, [keyIdentity.handle, keyIdentity.pid, 'right'], { windowsHide: true });
    for (const zone of zones.filter(zone => zone === process.argv[2])) {
      const identity = await app.evaluate(({ BrowserWindow, screen }, zone) => {
        const win = BrowserWindow.getAllWindows()[0];
        const display = screen.getPrimaryDisplay(), a = display.workArea, b = display.bounds;
        win.unmaximize(); win.setBounds({ x: a.x + 100, y: a.y + 100, width: 1000, height: 700 });
        win.setAlwaysOnTop(true); win.show(); win.focus(); win.moveTop();
        const offset = { x: Math.round(200 * display.scaleFactor), y: Math.round(20 * display.scaleFactor) };
        const target = screen.dipToScreenPoint({ x: zone.endsWith('left') ? b.x : b.x + b.width - 1,
          y: zone.startsWith('top') ? b.y : zone.startsWith('bottom') ? b.y + b.height - 1 : a.y + Math.floor(a.height / 2) });
        return { handle: win.getNativeWindowHandle().readBigUInt64LE().toString(), pid: String(process.pid), offset,
          target, area: a };
      }, zone);
      await shell.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const drag = await run(helper, [identity.handle, identity.pid, String(identity.offset.x), String(identity.offset.y), String(identity.target.x), String(identity.target.y), 'snap'], { windowsHide: true });
      assert.equal(JSON.parse(drag.stdout).hit, 2, 'The titlebar starts a native Windows caption drag');
      await shell.waitForTimeout(500);
      const actual = await app.evaluate(({ BrowserWindow }) => ({ bounds: BrowserWindow.getAllWindows()[0].getBounds(), snapped: BrowserWindow.getAllWindows()[0].snapped }));
      const a = identity.area, quarter = zone.includes('-');
      const expected = { x: zone.endsWith('left') ? a.x : a.x + a.width / 2,
        y: zone.startsWith('bottom') ? a.y + a.height / 2 : a.y, width: a.width / 2, height: quarter ? a.height / 2 : a.height };
      assert.equal(actual.snapped, true, `${zone}: Windows recognizes the snapped window: ${JSON.stringify(actual)}`);
      for (const key of Object.keys(expected)) assert.ok(Math.abs(actual.bounds[key] - expected[key]) <= 10, `${zone}/${key}: ${JSON.stringify(actual)}`);
      await site.evaluate(() => window.setScenario('normal', false));
      await checkChat(site, `native Snap ${zone}`);
      console.log(`Native mouse Snap passed: ${zone}, ${actual.bounds.width}x${actual.bounds.height}.`);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 500, height: 360 }));
    await shell.waitForFunction(() => innerWidth === 500 && innerHeight === 360);
    for (const selector of ['#maximize', '[data-action="minimize"]', '[data-action="close"]', '#update-action']) {
      const rect = await shell.locator(selector).boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= 500 && rect.y + rect.height <= 42, `${selector} stays reachable at the minimum size`);
    }
    console.log('Windows Snap regression passed: mouse edges/corners, caption hit test, chat layout, narrow titlebar and Win+Left.');
  } finally { if (app) await app.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
