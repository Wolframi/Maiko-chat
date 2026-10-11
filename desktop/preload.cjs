const { contextBridge, ipcRenderer } = require('electron');

// Only local shell/picker pages have this preload. The site has no Node bridge.
contextBridge.exposeInMainWorld('maikoDesktop', Object.freeze({
  state: () => ipcRenderer.invoke('desktop:state'),
  control: (action) => ipcRenderer.invoke('desktop:control', action),
  connect: (url) => ipcRenderer.invoke('desktop:connect', url),
  toggleSettings: (visible) => ipcRenderer.invoke('desktop:settings', visible),
  update: (action) => ipcRenderer.invoke('desktop:update', action),
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
