const { contextBridge, ipcRenderer } = require('electron');

// Only local shell/picker pages have this preload. The site has no Node bridge.
contextBridge.exposeInMainWorld('maikoDesktop', Object.freeze({
  state: () => ipcRenderer.invoke('desktop:state'),
  startupModel: (intro) => ipcRenderer.invoke('desktop:startup-model', intro),
  startupModelFinished: () => ipcRenderer.invoke('desktop:startup-model-finished'),
  control: (action) => ipcRenderer.invoke('desktop:control', action),
  update: (action) => ipcRenderer.invoke('desktop:update', action),
  downloads: (command, id) => ipcRenderer.invoke('desktop:downloads', command, id),
  downloadsPanel: (open, anchor) => ipcRenderer.invoke('desktop:downloads-panel', open, anchor),
  onDownloadsPanel: (callback) => {
    const handler = (_event, open) => callback(open);
    ipcRenderer.on('desktop:downloads-panel-visible', handler);
    return () => ipcRenderer.removeListener('desktop:downloads-panel-visible', handler);
  },
  captureSources: () => ipcRenderer.invoke('desktop:capture-sources'),
  captureSelect: (choice) => ipcRenderer.invoke('desktop:capture-select', choice),
  installDawBridge: () => ipcRenderer.invoke('desktop:capture-daw-install'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('desktop:state-changed', handler);
    return () => ipcRenderer.removeListener('desktop:state-changed', handler);
  },
}));
