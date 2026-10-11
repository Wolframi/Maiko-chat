const { contextBridge, ipcRenderer } = require('electron');

// Only local shell/picker pages have this preload. The site has no Node bridge.
contextBridge.exposeInMainWorld('maikoDesktop', Object.freeze({
  state: () => ipcRenderer.invoke('desktop:state'),
  control: (action) => ipcRenderer.invoke('desktop:control', action),
  update: (action) => ipcRenderer.invoke('desktop:update', action),
  downloads: (command, id) => ipcRenderer.invoke('desktop:downloads', command, id),
  downloadsPanel: (open, anchor) => ipcRenderer.invoke('desktop:downloads-panel', open, anchor),
  onDownloadsPanel: (callback) => {
    const handler = (_event, open) => callback(open);
    ipcRenderer.on('desktop:downloads-panel-visible', handler);
    return () => ipcRenderer.removeListener('desktop:downloads-panel-visible', handler);
  },
  resizeStart: (edge, point) => ipcRenderer.invoke('desktop:resize-start', edge, point),
  resizeMove: (point) => ipcRenderer.send('desktop:resize-move', point),
  resizeEnd: () => ipcRenderer.send('desktop:resize-end'),
  captureSources: () => ipcRenderer.invoke('desktop:capture-sources'),
  captureSelect: (choice) => ipcRenderer.invoke('desktop:capture-select', choice),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('desktop:state-changed', handler);
    return () => ipcRenderer.removeListener('desktop:state-changed', handler);
  },
}));
