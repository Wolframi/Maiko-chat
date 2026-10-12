const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RADIUS, makeWindowRectangular } = require('./window-geometry.cjs');
const { windowProcesses, audioPolicy } = require('./capture-audio.cjs');

function configureCapture({ siteSession, getWindow, getSite, trusted, testing, log }) {
  let pending;
  let choosing = false, completedAudioPolicy;
  const pickerUrl = pathToFileURL(path.join(__dirname, 'ui', 'capture.html')).href;
  function requirePicker(event) {
    if (!pending || event.sender !== pending.window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pickerUrl) {
      throw new Error('Нет активного выбора экрана');
    }
  }
  ipcMain.handle('desktop:capture-sources', (event) => {
    requirePicker(event);
    return { sources: pending.sources.map((source) => ({
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
    if (!source) { pending.finish(null); return; }
    selection.selecting = true;
    // Refresh the owning process at selection time: a window may have closed
    // or its HWND may have been reused while the chooser was open.
    let policy = null;
    if (choice.audio === true && pending.audioRequested) {
      try { policy = audioPolicy(source, await windowProcesses([source])); }
      catch (error) { log(`Screen audio unavailable: ${error.message}`); }
    }
    if (pending !== selection) return;
    completedAudioPolicy = policy ? { isolated: true, kind: policy.kind } : null;
    pending.finish({ video: source, ...(policy ? { audio: policy.device } : {}) });
  });
  ipcMain.handle('desktop:capture-audio-policy', (event) => {
    if (event.sender !== getSite()?.webContents || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) {
      throw new Error('Недоступно для этой страницы');
    }
    const policy = completedAudioPolicy;
    completedAudioPolicy = undefined;
    return policy || null;
  });
  siteSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (choosing || !request.frame || request.frame !== getSite()?.webContents.mainFrame || !trusted(request.securityOrigin)) {
      callback(null); return;
    }
    choosing = true;
    completedAudioPolicy = undefined;
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
      const finish = (streams) => {
        if (finished) return;
        finished = true;
        choosing = false;
        pending = undefined;
        if (!streams) completedAudioPolicy = undefined;
        if (!picker.isDestroyed()) picker.close();
        try { callback(request.frame && !getSite()?.webContents.isDestroyed() ? streams : null); }
        catch (error) { log(error.message); }
      };
      pending = { window: picker, sources, policies, finish, audioRequested: request.audioRequested && process.platform === 'win32' };
      picker.on('closed', () => finish(null));
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
