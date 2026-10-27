const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RADIUS, makeWindowRectangular } = require('./window-geometry.cjs');
const { windowProcesses, audioPolicy } = require('./capture-audio.cjs');
const { watchDawAudio } = require('./daw-audio.cjs');

function configureCapture({ siteSession, getWindow, getSite, trusted, testing, dawInstaller, log }) {
  let pending;
  let choosing = false, completedAudioPolicy;
  let dawGrant, stopDaw;
  app.once('will-quit', () => stopDaw?.());
  const pickerUrl = pathToFileURL(path.join(__dirname, 'ui', 'capture.html')).href;
  function requireSite(event) {
    if (event.sender !== getSite()?.webContents || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) {
      throw new Error('Недоступно для этой страницы');
    }
  }
  function requirePicker(event) {
    if (!pending || event.sender !== pending.window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pickerUrl) {
      throw new Error('Нет активного выбора экрана');
    }
  }
  ipcMain.handle('desktop:capture-daw-install', async (event) => {
    requirePicker(event);
    return dawInstaller.install();
  });
  ipcMain.handle('desktop:capture-sources', async (event) => {
    requirePicker(event);
    const selection = pending;
    const dawInstalled = process.platform === 'win32' && await dawInstaller.installed().catch(() => false);
    if (pending !== selection) throw new Error('Выбор экрана закрыт');
    return { dawInstalled, sources: pending.sources.map((source) => ({
      id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(),
      audioKind: pending.audioRequested ? pending.policies.get(source.id)?.kind || null : null,
    })), audioAvailable: pending.audioRequested };
  });
  ipcMain.handle('desktop:capture-select', async (event, choice) => {
    requirePicker(event);
    const selection = pending;
    if (selection.selecting && choice !== null) return;
    const source = pending.sources.find((entry) => entry.id === choice?.id);
    if (choice !== null && !source) throw new Error('Источник больше не доступен');
    if (!source) { pending.finish(null, true); return; }
    selection.selecting = true;
    // Refresh the owning process at selection time: a window may have closed
    // or its HWND may have been reused while the chooser was open.
    let policy = null;
    if (choice.audio === true && pending.audioRequested) {
      try { policy = audioPolicy(source, await windowProcesses([source])); }
      catch (error) { log(`Screen audio unavailable: ${error.message}`); }
    }
    if (pending !== selection) return;
    dawGrant = policy ? { token: randomUUID(), scope: { kind: policy.kind, processId: policy.processId, ownProcessId: process.pid } } : undefined;
    completedAudioPolicy = policy ? { isolated: true, kind: policy.kind, token: dawGrant.token } : null;
    pending.finish({ video: source, ...(policy ? { audio: policy.device } : {}) });
  });
  ipcMain.handle('desktop:capture-audio-policy', (event) => {
    requireSite(event);
    const policy = completedAudioPolicy;
    completedAudioPolicy = undefined;
    return policy || null;
  });
  ipcMain.handle('desktop:capture-daw-start', (event, token) => {
    requireSite(event);
    if (!dawGrant || token !== dawGrant.token) throw new Error('Нет разрешения на захват DAW');
    const grant = dawGrant; dawGrant = undefined;
    stopDaw?.();
    const owner = event.sender;
    let stop;
    const send = (packet) => {
      if (!owner.isDestroyed() && trusted(owner.getURL())) owner.send('desktop:capture-daw-audio', { token, ...packet });
    };
    const dispose = () => stop?.();
    const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) dispose(); };
    owner.once('destroyed', dispose);
    owner.once('render-process-gone', dispose);
    owner.on('did-start-navigation', navigate);
    const disconnect = watchDawAudio(grant.scope, send, { log });
    stop = () => {
      if (stopDaw !== stop) return;
      disconnect();
      owner.removeListener('destroyed', dispose);
      owner.removeListener('render-process-gone', dispose);
      owner.removeListener('did-start-navigation', navigate);
      stopDaw = undefined;
      send({ ended: true });
    };
    stop.token = token;
    stopDaw = stop;
  });
  ipcMain.handle('desktop:capture-daw-stop', (event, token) => {
    requireSite(event);
    if (stopDaw?.token === token) stopDaw();
    if (dawGrant?.token === token) dawGrant = undefined;
  });
  siteSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (choosing || !request.frame || request.frame !== getSite()?.webContents.mainFrame || !trusted(request.securityOrigin)) {
      callback(null); return;
    }
    choosing = true;
    completedAudioPolicy = undefined;
    dawGrant = undefined;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
      if (!sources.length || !request.frame || request.frame !== getSite()?.webContents.mainFrame) { choosing = false; callback(null); return; }
      let owners = {};
      if (request.audioRequested) {
        try { owners = await windowProcesses(sources); }
        catch (error) { log(`Window audio lookup: ${error.message}`); }
      }
      const policies = new Map(sources.map((source) => [source.id, audioPolicy(source, owners)]));
      const picker = new BrowserWindow({
        parent: getWindow(), modal: true, width: 780, height: 600,
        frame: false, roundedCorners: false, transparent: false, thickFrame: false, backgroundColor: '#141416',
        resizable: false, minimizable: false, maximizable: false, show: false,
        title: 'Демонстрация экрана — Майко',
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      makeWindowRectangular(picker);
      let finished = false;
      const finish = (streams, cancelled = false) => {
        if (finished) return;
        finished = true;
        choosing = false;
        pending = undefined;
        if (!streams) completedAudioPolicy = cancelled ? { cancelled: true } : undefined;
        if (!picker.isDestroyed()) picker.close();
        try { callback(request.frame && !getSite()?.webContents.isDestroyed() ? streams : null); }
        catch (error) { log(error.message); }
      };
      pending = { window: picker, sources, policies, finish, audioRequested: request.audioRequested && process.platform === 'win32' };
      picker.on('closed', () => finish(null, true));
      picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      picker.webContents.on('will-navigate', (event, url) => { if (url !== pickerUrl) event.preventDefault(); });
      picker.contentView.setBackgroundColor('#141416');
      picker.contentView.setBorderRadius(RADIUS);
      picker.once('ready-to-show', () => { if (!testing) picker.show(); });
      await picker.loadURL(pickerUrl);
    } catch (error) {
      log(error.message);
      choosing = false;
      if (pending) pending.finish(null); else callback(null);
    }
  });
}

module.exports = { configureCapture };
