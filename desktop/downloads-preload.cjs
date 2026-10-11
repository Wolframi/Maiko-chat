const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maikoDownloads', Object.freeze({
  state: () => ipcRenderer.invoke('desktop:downloads-panel-state'),
  action: async (command, id) => {
    const result = await ipcRenderer.invoke('desktop:downloads-panel-action', command, id);
    if (!result.ok) throw new Error(result.error);
  },
  hover: (open) => ipcRenderer.invoke('desktop:downloads-panel-hover', open),
  close: () => ipcRenderer.invoke('desktop:downloads-panel-close'),
  onOpen: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('desktop:downloads-panel-opened', handler);
    return () => ipcRenderer.removeListener('desktop:downloads-panel-opened', handler);
  },
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('desktop:downloads-panel-state-changed', handler);
    return () => ipcRenderer.removeListener('desktop:downloads-panel-state-changed', handler);
  },
}));
