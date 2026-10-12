const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, session, screen, utilityProcess, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeUrl, isSameOrigin, readJson, findProjectRoot, visibleBounds } = require('./config.cjs');
const { RADIUS, MIN_WIDTH, MIN_HEIGHT, siteBounds, makeWindowRectangular } = require('./window-geometry.cjs');
const { configureLocalAssets } = require('./local-assets.cjs');
const { startLocalServer } = require('./local-server.cjs');
const { configureCapture } = require('./screen-capture.cjs');
const { createUpdates } = require('./updates.cjs');
const { createDownloads } = require('./downloads.cjs');
const { configureDownloadsPanel } = require('./downloads-panel.cjs');

app.setName('Maiko');
// Match Chromium's unpainted surfaces and the Windows resize frame to our UI.
nativeTheme.themeSource = 'dark';
if (process.env.MAIKO_DESKTOP_USER_DATA) {
  fs.mkdirSync(process.env.MAIKO_DESKTOP_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.MAIKO_DESKTOP_USER_DATA);
}
const testing = process.env.MAIKO_DESKTOP_TEST === '1';
const defaults = readJson(path.join(__dirname, 'config.json'));
let win, site, localServer, shuttingDown = false;
let updates, downloads, downloadsPanel;
let loadGeneration = 0;
let layoutExpanded;
let siteUpdateTimer;
let state = { phase: 'loading', message: 'Запускаем Майко…', url: '', mode: process.argv.includes('--local') ? 'local' : 'remote', maximized: false };
const uiUrl = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
const siteLayoutCSS = fs.readFileSync(path.join(__dirname, 'ui/site-layout.css'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, 'ui/site-window.css'), 'utf8');
const compactMembersJS = fs.readFileSync(path.join(__dirname, 'ui/compact-members.js'), 'utf8');
const downloadProgressJS = fs.readFileSync(path.join(__dirname, 'ui/download-progress.js'), 'utf8');
const settingsPath = () => path.join(app.getPath('userData'), 'desktop-settings.json');
function log(message) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* logging is optional */ }
}
function publish(patch = {}) {
  const next = { ...state, ...patch, maximized: !!win && !win.isDestroyed() && (win.isMaximized() || win.isFullScreen()) };
  if (Object.keys(next).every((key) => next[key] === state[key])) return;
  state = next;
  if (win && !win.isDestroyed()) win.webContents.send('desktop:state-changed', state);
  downloadsPanel?.publish(state.downloads);
  if (patch.downloads && site && !site.webContents.isDestroyed() && trusted(site.webContents.getURL())) {
    site.webContents.send('desktop:site-downloads-changed', downloads?.siteProgress() || []);
  }
}
function layout() {
  if (!win || win.isDestroyed()) return;
  const expanded = win.isMaximized() || win.isFullScreen();
  // Keep the native content rectangular in normal and expanded modes.
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
function toggleMaximize() {
  if (win.isFullScreen()) { win.setFullScreen(false); return; }
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
}
function trusted(url) { return state.url && isSameOrigin(url, state.url); }
function requireShell(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
    throw new Error('Недоступно для этой страницы');
  }
}
function requireSite(event) {
  if (!site || event.sender !== site.webContents || event.senderFrame !== site.webContents.mainFrame || !trusted(event.senderFrame.url)) {
    throw new Error('Недоступно для этой страницы');
  }
}
function refreshInterface() {
  if (site && trusted(site.webContents.getURL()) && new URL(site.webContents.getURL()).pathname === '/desktop-runtime') {
    site.webContents.send('desktop:refresh-interface');
  } else void connect(state.url);
}
function siteUpdateState(phase) {
  if (phase === 'ready' && !['loading', 'error'].includes(state.siteUpdatePhase)) return;
  clearTimeout(siteUpdateTimer);
  publish({ siteUpdatePhase: phase });
  if (phase === 'ready') siteUpdateTimer = setTimeout(() => publish({ siteUpdatePhase: 'idle' }), 6000);
}

async function siteEntryUrl(target) {
  // Keep compatibility with deployed frontends that do not have a media
  // owner yet; fixtures and old servers continue to open their normal URL.
  if (new URL(target).pathname !== '/') return target;
  try {
    const response = await fetch(new URL('/api/health', target), { signal: AbortSignal.timeout(5000) });
    if (response.ok && (await response.json()).desktopMediaHost === 1) return new URL('/desktop-runtime', target).href;
  } catch { /* loading the normal site still reports connection errors */ }
  return target;
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
  contents.on('will-frame-navigate', (event) => {
    if (!trusted(event.url)) { event.preventDefault(); void openExternal(event.url); }
  });
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
      contents.executeJavaScriptInIsolatedWorld(1001, [{ code: new URL(contents.getURL()).pathname === '/desktop-runtime' ? `
        (() => {
          const install = (frame) => {
            const inject = () => {
              try {
                if (frame.contentWindow.location.origin !== location.origin) return;
                const childDocument = frame.contentDocument;
                if (!childDocument?.body || childDocument.querySelector('[data-maiko-layout]')) return;
                const style = childDocument.createElement('style');
                style.dataset.maikoLayout = '';
                style.textContent = ${JSON.stringify(siteLayoutCSS)};
                childDocument.head.append(style);
                ((document, window, globalThis, location, matchMedia, requestAnimationFrame, maikoDownloadProgress) => {
                  ${compactMembersJS}
                  ${downloadProgressJS.replace('const api = window.maikoDownloadProgress;', 'const api = maikoDownloadProgress;')}
                })(childDocument, frame.contentWindow, frame.contentWindow, frame.contentWindow.location,
                  frame.contentWindow.matchMedia.bind(frame.contentWindow), frame.contentWindow.requestAnimationFrame.bind(frame.contentWindow), window.maikoDownloadProgress);
              } catch { /* Do not grant anything to a cross-origin frame. */ }
            };
            frame.addEventListener('load', inject);
            inject();
          };
          const frame = document.querySelector('iframe[data-maiko-desktop-ui]');
          if (frame) install(frame);
          new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes)
              if (node instanceof HTMLIFrameElement && node.hasAttribute('data-maiko-desktop-ui')) install(node);
          }).observe(document.body, { childList: true, subtree: true });
        })();
      ` : compactMembersJS + '\n' + downloadProgressJS }]),
    ]).then(showSite).catch((error) => {
      log(`Desktop layout helpers unavailable: ${error.message}`);
      showSite();
    });
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (code === -3) return;
    if (!isMainFrame) { siteUpdateState('error'); return; }
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
      event.preventDefault(); refreshInterface();
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
    const entry = await siteEntryUrl(target);
    if (generation !== loadGeneration || !win || win.isDestroyed()) return;
    await site.webContents.loadURL(entry);
  } catch (error) {
    if (generation !== loadGeneration) return;
    site?.setVisible(false);
    log(error.stack || error.message);
    publish({ phase: 'error', message: error.message });
  }
}
function saveWindow() {
  if (!win || win.isDestroyed()) return;
  fs.writeFileSync(settingsPath(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }, null, 2));
}
function createWindow() {
  const saved = readJson(settingsPath());
  win = new BrowserWindow({
    ...visibleBounds(saved.bounds, screen.getAllDisplays()),
    minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT, frame: false, roundedCorners: false,
    // Windows owns edge hit testing and the native sizing loop.
    transparent: false, thickFrame: true, resizable: true, backgroundColor: '#0c0c0e', title: 'Майко',
    // PNG works reliably through NativeImage, including inside app.asar.
    // The builder uses the multi-size ICO for the executable and shortcuts.
    icon: path.join(__dirname, 'assets', 'icon.png'), show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setMenu(null);
  // Cover newly exposed pixels while Chromium draws its next frame.
  // The shell and site's native surfaces use the same dark background.
  win.contentView.setBackgroundColor('#0c0c0e');
  // The shell's native view needs its own dark fallback while its renderer
  // catches up during resizing.
  const shellView = win.contentView.children.find((view) => view.webContents === win.webContents);
  shellView?.setBackgroundColor('#0c0c0e');
  layoutExpanded = undefined;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  // Use committed client dimensions only. will-resize reports a proposal;
  // sizing the child there can expose a future viewport before the native
  // parent catches up (or Windows clamps it at the minimum size).
  win.on('resize', layout);
  win.on('resized', layout);
  win.on('resize', () => downloadsPanel?.hide());
  win.on('blur', () => downloadsPanel?.hide());
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(event, layout);
  win.on('close', () => { saveWindow(); });
  win.on('closed', () => {
    clearTimeout(siteUpdateTimer);
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
  makeWindowRectangular(createdWindow);
  void createdWindow.loadURL(uiUrl).then(() => {
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
    ipcMain.handle('desktop:site-downloads-state', (event) => { requireSite(event); return downloads.siteProgress(); });
    ipcMain.handle('desktop:site-downloads-cancel', (event, id) => { requireSite(event); return downloads.action('cancel', id); });
    ipcMain.handle('desktop:site-update-state', (event, phase) => {
      requireSite(event);
      if (new URL(event.senderFrame.url).pathname !== '/desktop-runtime' || !['loading', 'ready', 'error'].includes(phase)) {
        throw new Error('Недоступное состояние обновления');
      }
      siteUpdateState(phase);
    });
    ipcMain.handle('desktop:downloads', (event, command, id) => {
      requireShell(event);
      return downloads.action(command, id);
    });
    updates = createUpdates({ app, publish, log, testing, notificationUrl: defaults.url, prepareInstall: async () => {
      saveWindow();
      siteSession.flushStorageData();
      await siteSession.cookies.flushStore();
      // Stop an owned server before NSIS starts waiting for our processes.
      if (localServer?.owned) {
        await localServer.stop();
        localServer = undefined;
      }
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
      else if (action === 'reload') refreshInterface();
      else if (action === 'logs') void shell.openPath(path.join(app.getPath('userData'), 'desktop.log'));
      else throw new Error('Неизвестная команда окна');
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
