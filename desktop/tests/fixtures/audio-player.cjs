const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.MAIKO_AUDIO_TEST_PROFILE);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 360, height: 200, show: true, webPreferences: { backgroundThrottling: false, sandbox: true } });
  await win.loadURL(process.env.MAIKO_AUDIO_TEST_URL);
});
app.on('window-all-closed', () => app.quit());
