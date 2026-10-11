const { WebContentsView } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function configureDownloadsPanel({ ipcMain, getWindow, requireShell, downloads, log }) {
  const url = pathToFileURL(path.join(__dirname, 'ui/downloads-panel.html')).href;
  let view, anchor, hideTimer, visible = false;
  function requirePanel(event) {
    if (!view || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame || event.senderFrame.url !== url) {
      throw new Error('Недоступно для этой страницы');
    }
  }
  function notify() {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('desktop:downloads-panel-visible', visible);
  }
  function hide() {
    clearTimeout(hideTimer);
    if (view && !view.webContents.isDestroyed()) view.setVisible(false);
    visible = false; notify();
  }
  function hover(open, nextAnchor) {
    clearTimeout(hideTimer);
    if (!open) { hideTimer = setTimeout(hide, 220); return; }
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (nextAnchor && Number.isFinite(nextAnchor.x) && Number.isFinite(nextAnchor.width)) anchor = nextAnchor;
    if (!anchor) return;
    if (!view) {
      view = new WebContentsView({ webPreferences: {
        preload: path.join(__dirname, 'downloads-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      } });
      view.setBackgroundColor('#141416');
      view.setBorderRadius(12);
      view.setVisible(false);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault(); });
      view.webContents.on('will-attach-webview', (event) => event.preventDefault());
      void view.webContents.loadURL(url).catch((error) => { log(`Download panel: ${error.message}`); hide(); });
    }
    const [width, height] = win.getContentSize();
    const panelWidth = Math.min(350, width - 24);
    view.setBounds({ x: Math.round(Math.max(12, Math.min(width - panelWidth - 12, anchor.x + anchor.width - panelWidth))),
      y: 42, width: panelWidth, height: Math.min(360, height - 54) });
    // A DOM dropdown would sit behind the site's native view. This is a local
    // child surface in the same window, placed above the site without resizing it.
    win.contentView.addChildView(view);
    const opening = !visible;
    view.setVisible(true); visible = true; notify();
    if (opening) view.webContents.send('desktop:downloads-panel-opened');
  }
  ipcMain.handle('desktop:downloads-panel', (event, open, nextAnchor) => {
    requireShell(event); hover(open === true, nextAnchor);
  });
  ipcMain.handle('desktop:downloads-panel-hover', (event, open) => { requirePanel(event); hover(open === true); });
  ipcMain.handle('desktop:downloads-panel-close', (event) => { requirePanel(event); hide(); });
  ipcMain.handle('desktop:downloads-panel-state', (event) => { requirePanel(event); return downloads.snapshot(); });
  ipcMain.handle('desktop:downloads-panel-action', async (event, command, id) => {
    requirePanel(event);
    try { await downloads.action(command, id); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  return {
    hide,
    publish(state) {
      if (state && view && !view.webContents.isDestroyed()) view.webContents.send('desktop:downloads-panel-state-changed', state);
    },
    dispose() {
      hide();
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
      view = undefined; anchor = undefined;
    },
  };
}

module.exports = { configureDownloadsPanel };
