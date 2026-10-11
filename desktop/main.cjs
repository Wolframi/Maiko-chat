const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, session, screen, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeUrl, isSameOrigin, readJson, findProjectRoot, visibleBounds } = require('./config.cjs');
const { EDGES, RADIUS, resizedBounds, siteBounds } = require('./window-geometry.cjs');
const { configureLocalAssets } = require('./local-assets.cjs');
const { startLocalServer } = require('./local-server.cjs');
const { configureCapture } = require('./screen-capture.cjs');
const { enableNativeWindowAnimations } = require('./window-animations.cjs');
const { createUpdates } = require('./updates.cjs');
const { createDownloads } = require('./downloads.cjs');
const { configureDownloadsPanel } = require('./downloads-panel.cjs');

app.setName('Maiko');
if (process.env.MAIKO_DESKTOP_USER_DATA) {
  fs.mkdirSync(process.env.MAIKO_DESKTOP_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.MAIKO_DESKTOP_USER_DATA);
}
const testing = process.env.MAIKO_DESKTOP_TEST === '1';
const defaults = readJson(path.join(__dirname, 'config.json'));
let win, site, localServer, shuttingDown = false;
let updates, downloads, downloadsPanel;
let loadGeneration = 0;
let maximized = false, restoreBounds, resizeGesture, layoutExpanded;
let state = { phase: 'loading', message: 'Запускаем Майко…', url: '', mode: process.argv.includes('--local') ? 'local' : 'remote', maximized: false };
const uiUrl = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
const siteLayoutCSS = fs.readFileSync(path.join(__dirname, 'ui/site-layout.css'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, 'ui/site-window.css'), 'utf8');
const compactMembersJS = fs.readFileSync(path.join(__dirname, 'ui/compact-members.js'), 'utf8');
const settingsPath = () => path.join(app.getPath('userData'), 'desktop-settings.json');
function log(message) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* logging is optional */ }
}
function publish(patch = {}) {
  const next = { ...state, ...patch, maximized: !!win && !win.isDestroyed() && (maximized || win.isFullScreen()) };
  if (Object.keys(next).every((key) => next[key] === state[key])) return;
  state = next;
  if (win && !win.isDestroyed()) win.webContents.send('desktop:state-changed', state);
  downloadsPanel?.publish(state.downloads);
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const expanded = maximized || win.isFullScreen();
  // GPU clipping preserves fractional alpha at the corners, unlike setShape.
  if (layoutExpanded !== expanded) {
    win.contentView.setBorderRadius(expanded ? 0 : RADIUS);
    layoutExpanded = expanded;
  }
  if (site) {
    const [width, height] = win.getContentSize();
    sizeSite(width, height, expanded);
  }
  publish();
}
function sizeSite(width, height, expanded) {
  if (!site) return;
  const next = siteBounds(width, height, expanded);
  const current = site.getBounds();
  if (Object.keys(next).some((key) => next[key] !== current[key])) site.setBounds(next);
}
function setWindowBounds(bounds) {
  // Size the child before the parent exposes a larger client area. Otherwise
  // Windows can compose the old site surface next to a newly enlarged window.
  sizeSite(bounds.width, bounds.height, maximized || win.isFullScreen());
  win.setBounds(bounds, false);
  layout();
}
function toggleMaximize() {
  resizeGesture = undefined;
  if (win.isFullScreen()) { win.setFullScreen(false); return; }
  if (maximized) {
    maximized = false;
    setWindowBounds(visibleBounds(restoreBounds, screen.getAllDisplays()));
  } else {
    restoreBounds = win.getBounds();
    maximized = true;
    setWindowBounds(screen.getDisplayMatching(restoreBounds).workArea);
  }
  layout();
}
function trusted(url) { return state.url && isSameOrigin(url, state.url); }
function requireShell(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
    throw new Error('Недоступно для этой страницы');
  }
}
async function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) await shell.openExternal(parsed.href);
  } catch (error) { log(error.message); }
}
function createSite() {
  const view = new WebContentsView({ webPreferences: {
    partition: 'persist:maiko-site', sandbox: true, contextIsolation: true,
    preload: path.join(__dirname, 'site-preload.cjs'),
    nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  } });
  view.setBackgroundColor('#0c0c0e');
  view.setVisible(false);
  win.contentView.addChildView(view);
  const contents = view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (trusted(url) && new URL(url).pathname.startsWith('/uploads/') && new URL(url).searchParams.has('download')) contents.downloadURL(url);
    else void openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (!trusted(url)) { event.preventDefault(); void openExternal(url); }
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) publish({ phase: 'loading', message: 'Подключаемся…' });
  });
  const showSite = () => {
    if (!trusted(contents.getURL())) return;
    publish({ phase: 'ready', message: state.mode === 'local' ? 'Локальный сервер' : 'Подключено' });
    view.setVisible(true);
    contents.focus();
  };
  contents.on('dom-ready', () => {
    if (!trusted(contents.getURL())) return;
    void Promise.all([
      contents.insertCSS(siteLayoutCSS),
      contents.executeJavaScriptInIsolatedWorld(1001, [{ code: compactMembersJS }]),
    ]).then(showSite).catch((error) => {
      log(`Desktop layout helpers unavailable: ${error.message}`);
      showSite();
    });
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    view.setVisible(false);
    publish({ phase: 'error', message: `Не удалось открыть Майко (${description}). Проверьте соединение и попробуйте снова.` });
  });
  contents.on('render-process-gone', (_event, details) => {
    view.setVisible(false);
    publish({ phase: 'error', message: 'Страница закрылась. Нажмите «Повторить».', detail: details.reason });
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
      event.preventDefault(); void connect(state.url);
    }
    if (input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    if (!app.isPackaged && input.key === 'F12') { event.preventDefault(); contents.toggleDevTools(); }
  });
  return view;
}
async function connect(url) {
  const generation = ++loadGeneration;
  site?.setVisible(false);
  publish({ phase: 'loading', message: 'Запускаем Майко…' });
  try {
    log(`Connecting in ${state.mode} mode`);
    let target = url;
    if (state.mode === 'local') {
      if (!localServer) {
        const root = findProjectRoot(process.env.MAIKO_PROJECT_DIR || (app.isPackaged ? path.dirname(process.execPath) : __dirname));
        const port = Number(process.env.MAIKO_LOCAL_PORT || defaults.localPort || 3000);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('localPort должен быть числом от 1024 до 65535.');
        localServer = await startLocalServer({ root, port, utilityProcess, onLog: log, dev: process.argv.includes('--dev') });
      }
      target = localServer.url;
    }
    target = normalizeUrl(target);
    if (generation !== loadGeneration || !win || win.isDestroyed()) return;
    publish({ url: target });
    if (!site) { site = createSite(); layout(); }
    await site.webContents.loadURL(target);
  } catch (error) {
    if (generation !== loadGeneration) return;
    site?.setVisible(false);
    log(error.stack || error.message);
    publish({ phase: 'error', message: error.message });
  }
}
function saveWindow() {
  if (!win || win.isDestroyed()) return;
  fs.writeFileSync(settingsPath(), JSON.stringify({ bounds: maximized ? restoreBounds : win.getNormalBounds(), maximized }, null, 2));
}
function createWindow() {
  const saved = readJson(settingsPath());
  win = new BrowserWindow({
    ...visibleBounds(saved.bounds, screen.getAllDisplays()),
    minWidth: 800, minHeight: 600, frame: false, roundedCorners: true,
    // Windows 10 needs per-pixel transparency for smooth outer corners.
    // Native thick frames break it; resizing is handled by the eight shell grips.
    transparent: true, thickFrame: false, resizable: false, backgroundColor: '#00000000', title: 'Майко',
    // PNG works reliably through NativeImage, including inside app.asar.
    // The builder uses the multi-size ICO for the executable and shortcuts.
    icon: path.join(__dirname, 'assets', 'icon.png'), show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setMenu(null);
  // Cover newly exposed pixels while Chromium draws its next frame. The GPU
  // corner clip still keeps the outside of the rounded window transparent.
  win.contentView.setBackgroundColor('#0c0c0e');
  layoutExpanded = undefined;
  const animationsReady = enableNativeWindowAnimations(win).catch((error) => {
    log(`Native window animations unavailable: ${error.message}`);
  });
  maximized = false;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  win.on('resize', layout);
  win.on('resize', () => downloadsPanel?.hide());
  win.on('blur', () => downloadsPanel?.hide());
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(event, layout);
  win.on('close', () => { saveWindow(); });
  win.on('closed', () => {
    loadGeneration++;
    downloadsPanel?.dispose();
    if (site && !site.webContents.isDestroyed()) site.webContents.close();
    site = undefined; win = undefined;
  });
  win.once('ready-to-show', () => {
    if (saved.maximized) toggleMaximize();
    layout();
    if (!testing) win.show();
  });
  const createdWindow = win;
  void animationsReady.then(() => {
    if (createdWindow.isDestroyed()) return;
    return createdWindow.loadURL(uiUrl);
  }).then(() => {
    if (createdWindow.isDestroyed()) return;
    publish();
    return connect((testing || !app.isPackaged ? process.env.MAIKO_DESKTOP_URL : undefined) || defaults.url);
  }).catch((error) => { if (win && !win.isDestroyed()) log(error.stack || error.message); });
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  });
  app.whenReady().then(() => {
    app.setAppUserModelId('io.maiko.desktop');
    Menu.setApplicationMenu(null);
    const siteSession = session.fromPartition('persist:maiko-site');
    configureLocalAssets({ siteSession, trusted, log });
    const allowed = new Set(['media', 'notifications', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);
    siteSession.setPermissionCheckHandler((contents, permission, origin) =>
      !!site && contents === site.webContents && trusted(origin) && allowed.has(permission));
    siteSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(!!site && contents === site.webContents && trusted(details.requestingUrl || contents.getURL()) && allowed.has(permission));
    });
    configureCapture({ siteSession, getWindow: () => win, getSite: () => site, trusted, testing, log });
    downloads = createDownloads({
      directory: path.join(testing && process.env.MAIKO_DESKTOP_DOWNLOADS_DIR || app.getPath('downloads'), 'Maiko'),
      historyPath: path.join(app.getPath('userData'), 'downloads.json'),
      siteSession, getSite: () => site, trusted, publish, shell, log,
    });
    downloadsPanel = configureDownloadsPanel({ ipcMain, getWindow: () => win, requireShell, downloads, log });
    ipcMain.handle('desktop:downloads', (event, command, id) => {
      requireShell(event);
      return downloads.action(command, id);
    });
    updates = createUpdates({ app, publish, log, testing, beforeInstall: async () => {
      if (localServer?.owned) await localServer.stop();
      localServer = undefined;
    } });
    ipcMain.handle('desktop:update', (event, action) => { requireShell(event); return updates.action(action); });
    ipcMain.handle('desktop:state', (event) => { requireShell(event); return state; });
    ipcMain.handle('desktop:control', (event, action) => {
      requireShell(event);
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') {
        toggleMaximize();
      }
      else if (action === 'close') win.close();
      else if (action === 'reload') void connect(state.url);
      else if (action === 'logs') void shell.openPath(path.join(app.getPath('userData'), 'desktop.log'));
      else throw new Error('Неизвестная команда окна');
    });
    ipcMain.handle('desktop:resize-start', (event, edge, point) => {
      requireShell(event);
      if (!EDGES.has(edge) || maximized || win.isFullScreen() || !validPoint(point)) return false;
      resizeGesture = { edge, bounds: win.getBounds(), point };
      return true;
    });
    ipcMain.on('desktop:resize-move', (event, point) => {
      try { requireShell(event); } catch { return; }
      if (!resizeGesture || !validPoint(point)) return;
      const { bounds, edge, point: start } = resizeGesture;
      const next = resizedBounds(bounds, edge, point.x - start.x, point.y - start.y);
      const current = win.getBounds();
      if (Object.keys(next).some((key) => next[key] !== current[key])) setWindowBounds(next);
    });
    ipcMain.on('desktop:resize-end', (event) => {
      try { requireShell(event); resizeGesture = undefined; } catch { /* untrusted sender */ }
    });
    createWindow();
    updates.start();
    app.once('will-quit', () => { updates.dispose(); downloads.dispose(); });
    app.on('activate', () => { if (!win) createWindow(); });
  }).catch((error) => { log(error.stack); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    if (shuttingDown || !localServer?.owned) return;
    event.preventDefault(); shuttingDown = true;
    void localServer.stop().finally(() => app.quit());
  });
}

function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) < 100000 && Math.abs(point.y) < 100000;
}
