const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createUpdateHandoff } = require('../update-handoff.cjs');

async function fixture(t, failure = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maiko-handoff-unit-'));
  const helper = path.join(root, 'source.exe');
  await fs.writeFile(helper, 'helper');
  const live = new Set(), events = [], children = [];
  const timers = [];
  t.after(async () => {
    timers.forEach(clearInterval);
    // This temporary directory was created by this test; verify before removal.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('maiko-handoff-unit-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const image = { toPNG: () => Buffer.from('image') };
  const win = { visible: true, isDestroyed: () => false, isMinimized: () => false,
    isVisible() { return this.visible; }, hide() { this.visible = false; events.push('hide'); },
    show() { this.visible = true; events.push('show'); }, focus() {},
    getContentSize: () => [1000, 700], getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
    webContents: { capturePage: async () => { events.push('paint'); return image; } } };
  const site = { getBounds: () => ({ x: 0, y: 42, width: 1000, height: 658 }),
    webContents: { isDestroyed: () => false, getURL: () => 'https://maiko.test', capturePage: async () => { events.push('paint'); return image; } } };
  const options = { app: { getPath: () => root, getVersion: () => '1.1.8' }, getWindow: () => win, getSite: () => site,
    platform: 'win32', helperPath: helper, modelPath: helper, isAlive: pid => live.has(pid), timeout: 300,
    spawnProcess(file, args, options) {
      assert.equal(options.detached, true);
      assert.equal(options.windowsHide, true);
      assert.ok(file.startsWith(path.join(root, 'update-handoff') + path.sep), 'Copy the helper outside the install directory');
      const child = Object.assign(new EventEmitter(), { pid: 1234 + children.length, exitCode: null, unref() {} });
      children.push(child); live.add(child.pid);
      const directory = args[0], token = args[1];
      void fs.writeFile(path.join(directory, 'ready.json'), JSON.stringify({ token: failure ? 'wrong' : token, pid: child.pid }));
      const timer = setInterval(async () => {
        for (const marker of ['cancel', 'complete']) {
          try {
            if (await fs.readFile(path.join(directory, marker), 'utf8') !== token) continue;
            events.push(marker); live.delete(child.pid); child.exitCode = 0;
            await fs.writeFile(path.join(directory, 'closed'), 'closed'); clearInterval(timer);
          } catch { }
        }
      }, 5);
      timers.push(timer);
      return child;
    } };
  return { root, options, win, site, live, events, children, controller: createUpdateHandoff(options) };
}

test('handoff is acknowledged before hiding the old window and completed after the new UI paints', async t => {
  const f = await fixture(t);
  await f.controller.prepare('1.1.9');
  assert.equal(f.win.visible, false);
  const pointer = path.join(f.root, 'update-handoff/current.json');
  const session = JSON.parse(await fs.readFile(pointer, 'utf8'));
  const wrongVersion = createUpdateHandoff(f.options);
  assert.equal(wrongVersion.incoming, false, 'Do not complete a handoff from the old EXE');
  const next = createUpdateHandoff({ ...f.options, app: { getPath: () => f.root, getVersion: () => '1.1.9' } });
  assert.equal(next.incoming, true);
  await next.finish();
  assert.equal(f.win.visible, true);
  assert.equal(next.incoming, false);
  assert.ok(f.events.lastIndexOf('paint') < f.events.indexOf('complete'), 'Paint before dismissing the helper');
  await assert.rejects(fs.stat(pointer), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.root, 'update-handoff', session.id)), { code: 'ENOENT' });
});

test('a failed helper handshake keeps the original window and removes the failed session', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.controller.prepare('1.1.9'), /окно обновления/);
  assert.equal(f.win.visible, true);
  assert.equal(f.events.includes('hide'), false, 'Never hide the app before a valid acknowledgement');
  assert.equal(f.live.size, 0);
});

test('installer failure cancels the helper and restores the old window', async t => {
  const f = await fixture(t);
  await f.controller.prepare('1.1.9');
  await f.controller.cancel();
  assert.equal(f.win.visible, true);
  assert.equal(f.live.size, 0);
});

test('handoff preserves animation time after the first dance clip', async t => {
  const f = await fixture(t);
  f.win.webContents.executeJavaScript = async () => ({ intro: 'samba', start: 2, elapsed: 9.25 });
  await f.controller.prepare('1.1.9');
  const pointer = JSON.parse(await fs.readFile(path.join(f.root, 'update-handoff/current.json'), 'utf8'));
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'update-handoff', pointer.id, 'config.json'), 'utf8'));
  assert.equal(config.animationElapsed, 9.25, 'Do not clamp a running loop to the old frozen pose');
  assert.equal(config.danceStart, 2);
  await f.controller.cancel();
});

test('malformed, expired or dead helper sessions cannot suppress normal startup', async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, 'update-handoff');
  await fs.mkdir(folder);
  for (const patch of [{ id: '../escape' }, { createdAt: 0 }, { token: 'wrong' }]) {
    await fs.writeFile(path.join(folder, 'current.json'), JSON.stringify({ id: '../escape', token: 'a'.repeat(32), version: '1.1.8', createdAt: Date.now(), ...patch }));
    assert.equal(createUpdateHandoff(f.options).incoming, false);
  }
});
