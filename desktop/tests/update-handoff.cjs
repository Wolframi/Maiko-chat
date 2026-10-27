const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { version } = require('../package.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
  let pending;
  const server = http.createServer((req, res) => {
    if (req.url === '/new') { pending = res; return; }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><body style="margin:0;background:#293d51;color:white">Майко — тест обновления</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = path.resolve(__dirname, '../test-output');
  const profile = path.join(output, `handoff-${Date.now()}`);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: profile, MAIKO_DESKTOP_URL: origin + '/old' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, session;
  try {
    const launch = () => electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 60000 });
    app = await launch();
    let shell = await app.firstWindow();
    await shell.waitForFunction(() => document.body.dataset.phase === 'ready');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 100, y: 100, width: 1000, height: 700 }));
    await app.evaluate(async ({ app, BrowserWindow }, version) => {
      const testRequire = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const win = BrowserWindow.getAllWindows()[0];
      global.testHandoff = testRequire('./update-handoff.cjs').createUpdateHandoff({ app, getWindow: () => win,
        getSite: () => win.contentView.children.find(view => /^http:/.test(view.webContents?.getURL())),
        showWindow: false, preview: true });
      await global.testHandoff.prepare(version);
    }, version);
    const pointer = JSON.parse(await fs.readFile(path.join(profile, 'update-handoff/current.json'), 'utf8'));
    const directory = path.join(profile, 'update-handoff', pointer.id);
    session = { directory, token: pointer.token, ...JSON.parse(await fs.readFile(path.join(directory, 'ready.json'), 'utf8')) };
    await fs.copyFile(path.join(directory, 'preview.png'), path.join(output, 'update-handoff.png'));
    assert.ok(alive(session.pid));
    // ElectronApplication.close() can wait for detached children. Simulate the
    // app's actual quit, then wait only for the old Electron PID to disappear.
    const oldPid = app.process().pid;
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    for (let attempt = 0; alive(oldPid) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(oldPid), false);
    app = null;
    assert.ok(alive(session.pid), 'The copied native window survives the entire old Electron process');
    env.MAIKO_DESKTOP_URL = origin + '/new';
    app = await launch();
    shell = await app.firstWindow();
    await shell.waitForFunction(async () => (await window.maikoDesktop?.state())?.startupCovered === true);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.equal(await shell.locator('#startup-model').getAttribute('data-state'), null, 'The new process does not replay the model');
    assert.ok(alive(session.pid), 'The helper stays up while the new interface waits on the network');
    const nextPreview = path.join(directory, 'preview-next.png');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.stat(nextPreview); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.notDeepEqual(await fs.readFile(nextPreview), await fs.readFile(path.join(directory, 'preview.png')), 'The local model keeps animating after the old process has exited');
    for (let attempt = 0; !pending && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(pending);
    pending.setHeader('content-type', 'text/html'); pending.end('<!doctype html><body>Новая версия готова</body>');
    await shell.waitForFunction(async () => { const state = await window.maikoDesktop.state(); return state.phase === 'ready' && state.startupCovered === false; });
    for (let attempt = 0; alive(session.pid) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(session.pid), false, 'Only the fully painted new UI dismisses the helper');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.stat(path.join(profile, 'update-handoff/current.json')); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await assert.rejects(fs.stat(path.join(profile, 'update-handoff/current.json')), { code: 'ENOENT' });
    console.log('Native update handoff passed: independent copied EXE, survives old process exit, covers delayed new startup, no repeated model, acknowledgement after paint and cleanup. NSIS execution is simulated.');
  } finally {
    pending?.end();
    if (session && alive(session.pid)) await fs.writeFile(path.join(session.directory, 'cancel'), session.token).catch(() => {});
    await app?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
