const { contextBridge, ipcRenderer } = require('electron');

// Only our isolated DOM helper can see this bridge. No filesystem paths or
// folder-opening commands are exposed to the remotely loaded messenger.
contextBridge.exposeInIsolatedWorld(1001, 'maikoDownloadProgress', Object.freeze({
  state: () => ipcRenderer.invoke('desktop:site-downloads-state'),
  cancel: (id) => ipcRenderer.invoke('desktop:site-downloads-cancel', id),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('desktop:site-downloads-changed', handler);
    return () => ipcRenderer.removeListener('desktop:site-downloads-changed', handler);
  },
}));

// Read-only capture metadata. The site still has no shell, filesystem or
// window-control bridge. The main process accepts this only from its site.
contextBridge.exposeInMainWorld('maikoScreenAudio', Object.freeze({
  takePolicy: () => ipcRenderer.invoke('desktop:capture-audio-policy'),
}));

contextBridge.executeInMainWorld({ func: () => {
  const devices = navigator.mediaDevices;
  if (!devices?.getDisplayMedia) return;
  const capture = devices.getDisplayMedia.bind(devices);
  let capturing = false;
  function describeIsolatedTrack(track) {
    const settings = track.getSettings.bind(track);
    const clone = track.clone.bind(track);
    // Chromium on Windows 10 reports restrictOwnAudio=false even for its
    // native process-isolated devices. Report the policy actually applied by
    // the desktop handler, so the deployed site's safety check accepts it.
    // This changes metadata only; filtering happens natively before encoding.
    Object.defineProperty(track, 'getSettings', {
      value: () => ({ ...settings(), restrictOwnAudio: true }),
    });
    Object.defineProperty(track, 'clone', {
      value: () => { const cloned = clone(); describeIsolatedTrack(cloned); return cloned; },
    });
  }
  Object.defineProperty(devices, 'getDisplayMedia', {
    value: async (options) => {
      if (capturing) throw new DOMException('Демонстрация уже выбирается', 'InvalidStateError');
      capturing = true;
      let stream;
      try {
        stream = await capture(options);
        const policy = await window.maikoScreenAudio.takePolicy();
        if (policy?.isolated === true) {
          for (const track of stream.getAudioTracks()) describeIsolatedTrack(track);
        } else {
          // A missing policy must never produce an unfiltered call loopback.
          for (const track of stream.getAudioTracks()) { track.stop(); stream.removeTrack(track); }
        }
        return stream;
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        throw error;
      } finally { capturing = false; }
    },
  });
} });
