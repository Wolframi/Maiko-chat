const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const SESSION_FILES = ['config.json', 'shell.png', 'model.bin', 'preview.png', 'preview-next.png', 'update-window.exe', 'ready.json', 'complete', 'cancel', 'closed'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = filename => { try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function createUpdateHandoff({ app, getWindow, getSite, log = () => {}, platform = process.platform,
  helperPath = path.join(__dirname, 'native/update-window.exe').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'),
  modelPath,
  spawnProcess = spawn, isAlive = alive, showWindow, preview = false, timeout = 5000 }) {
  const root = path.join(app.getPath('userData'), 'update-handoff');
  const pointer = path.join(root, 'current.json');
  let outgoing, finishing;
  function sessionAt(id) {
    if (typeof id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(id)) throw new Error('Invalid handoff session');
    return path.join(root, id);
  }
  function active() {
    if (platform !== 'win32') return null;
    const value = read(pointer);
    if (!value || !/^[\da-f]{32}$/.test(value.token) || !/^\d+\.\d+\.\d+$/.test(value.version)
      || !Number.isFinite(value.createdAt) || Math.abs(Date.now() - value.createdAt) > 15 * 60 * 1000) return null;
    try {
      const directory = sessionAt(value.id);
      const ready = read(path.join(directory, 'ready.json'));
      const config = read(path.join(directory, 'config.json'));
      if (ready?.token !== value.token || config?.token !== value.token || !Number.isInteger(ready.pid) || !isAlive(ready.pid)
        || fs.existsSync(path.join(directory, 'closed'))) return null;
      return { ...value, directory, pid: ready.pid, visible: config.visible, minimized: config.minimized };
    } catch { return null; }
  }
  let incoming = active();
  if (incoming?.version !== app.getVersion()) incoming = null;

  async function cleanup(session) {
    // Delete only enumerated files in the validated, application-owned session.
    if (session.directory !== sessionAt(session.id)) throw new Error('Invalid handoff cleanup path');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!isAlive(session.pid)) break;
      await pause(100);
    }
    if (isAlive(session.pid)) return;
    if (read(pointer)?.id === session.id) await fs.promises.unlink(pointer).catch(() => {});
    for (const name of SESSION_FILES) await fs.promises.unlink(path.join(session.directory, name)).catch(() => {});
    await fs.promises.rmdir(session.directory).catch(() => {});
  }
  async function cancel() {
    const session = outgoing;
    outgoing = null;
    if (!session) return;
    await fs.promises.writeFile(path.join(session.directory, 'cancel'), session.token);
    const win = getWindow();
    if (session.wasVisible && win && !win.isDestroyed()) { win.show(); win.focus(); }
    await cleanup(session);
  }
  async function prepare(version) {
    if (platform !== 'win32') return;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid update version');
    await cancel();
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('Окно приложения недоступно.');
    const id = randomUUID(), token = randomBytes(16).toString('hex');
    const directory = sessionAt(id);
    await fs.promises.mkdir(directory, { recursive: true });
    const session = { id, token, directory, version, createdAt: Date.now(), wasVisible: win.isVisible() && !win.isMinimized() };
    outgoing = session;
    try {
      // Retain only the local window chrome. The body is animated from copied
      // model data, so installation does not wait for a site screenshot.
      const shell = await win.webContents.capturePage(undefined, { stayHidden: true });
      await fs.promises.writeFile(path.join(directory, 'shell.png'), shell.toPNG());
      const animation = win.webContents.executeJavaScript ? await win.webContents.executeJavaScript(`(() => {
        const canvas = document.getElementById('startup-model');
        return { intro: canvas?.dataset.intro, start: Number(canvas?.dataset.danceStart) || 0,
          elapsed: canvas && !canvas.hidden ? Number(canvas.dataset.elapsed) || 0 : 0 };
      })()`).catch(() => ({})) : {};
      const intro = ['hiphop', 'samba'].includes(animation.intro) ? animation.intro : 'hiphop';
      const animationElapsed = Number.isFinite(animation.elapsed) ? Math.max(0, animation.elapsed) : 0;
      const danceStart = Number.isFinite(animation.start) ? Math.max(0, Math.min(3600, animation.start)) : 0;
      const [width, height] = win.getContentSize();
      const handle = win.getNativeWindowHandle();
      const windowId = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      const visible = showWindow ?? !win.isMinimized();
      await fs.promises.writeFile(path.join(directory, 'config.json'), JSON.stringify({ token, version, visible, minimized: win.isMinimized(), preview,
        windowId, owner: process.pid, width, height, animationElapsed, danceStart }));
      await fs.promises.copyFile(helperPath, path.join(directory, 'update-window.exe'));
      await fs.promises.copyFile(modelPath || path.join(__dirname, 'bundled-assets/models', `maiko-${intro}.bin`), path.join(directory, 'model.bin'));
      // The helper and its images live outside the installation directory.
      // They retain no Electron DLL, app.asar or running EXE during replacement.
      const child = spawnProcess(path.join(directory, 'update-window.exe'), [directory, token], {
        detached: true, windowsHide: true, stdio: 'ignore',
      });
      session.pid = child.pid;
      let failure;
      const failed = error => { failure = error; };
      child.on('error', failed);
      try {
        const deadline = Date.now() + timeout;
        for (;;) {
          if (failure) throw failure;
          const ready = read(path.join(directory, 'ready.json'));
          if (ready?.token === token && ready.pid === child.pid) break;
          if (typeof child.exitCode === 'number' || Date.now() >= deadline) throw new Error('Не удалось подготовить окно обновления.');
          await pause(50);
        }
      } finally { child.removeListener('error', failed); }
      await fs.promises.writeFile(pointer, JSON.stringify({ id, token, version, createdAt: session.createdAt }));
      child.unref();
      if (session.wasVisible) win.hide();
    } catch (error) {
      await cancel();
      throw error;
    }
  }
  async function finish(readyContents) {
    if (finishing) return finishing;
    if (!incoming) return;
    const session = incoming;
    finishing = (async () => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      if (session.visible) win.show();
      else if (session.minimized) { win.showInactive(); win.minimize(); }
      // Keep the helper above the new window until its actual UI has painted.
      const contents = readyContents || getSite()?.webContents || win.webContents;
      try { await contents.capturePage(undefined, { stayHidden: !session.visible }); }
      catch (error) { log(`Update handoff paint: ${error.message}`); }
      await fs.promises.writeFile(path.join(session.directory, 'complete'), session.token);
      incoming = null;
      for (let attempt = 0; attempt < 30 && !fs.existsSync(path.join(session.directory, 'closed')); attempt++) await pause(50);
      if (session.visible && !win.isDestroyed()) win.focus();
      await cleanup(session);
    })();
    return finishing;
  }
  return { prepare, cancel, finish, get incoming() { return !!incoming; } };
}

module.exports = { createUpdateHandoff };
