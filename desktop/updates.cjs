const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

// The local shell owns update commands; the remote site never gets this API.
function createUpdates({ app, publish, log, applyInterfaceUpdate = async () => {}, testing = false,
  platform = process.platform, portable = !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE),
  getUpdater = () => require('electron-updater').autoUpdater }) {
  let state = { phase: 'idle', currentVersion: app.getVersion(), version: '', progress: 0,
    message: 'Проверяем новые версии автоматически.' };
  let busy = false, startupTimer, interval;
  const send = (patch) => { state = { ...state, ...patch }; publish({ update: { ...state } }); };
  if (!app.isPackaged || testing || platform !== 'win32' || portable) {
    send({ phase: 'disabled', message: portable
      ? 'Для обновлений установите Майко через Maiko-Setup.'
      : 'Обновления доступны в установленном приложении для Windows.' });
    return { action: async () => { throw new Error(state.message); }, start() {}, dispose() {} };
  }
  const updater = getUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.autoRunAppAfterInstall = false;
  updater.disableWebInstaller = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = { info: log, warn: log, error: log, debug: () => {} };
  const handlers = {
    'checking-for-update': () => send({ phase: 'checking', message: 'Проверяем обновления…', progress: 0 }),
    'update-available': (info) => send({ phase: 'available', version: info.version, message: `Доступна версия ${info.version}.` }),
    'update-not-available': () => send({ phase: 'current', version: '', progress: 0, retryAction: '', message: 'Обновлено. Установлена последняя версия.' }),
    'download-progress': (info) => send({ phase: 'downloading', progress: Math.min(100, Math.max(0, Math.round(info.percent))), message: 'Скачиваем обновление…' }),
    'update-downloaded': (info) => send({ phase: 'downloaded', version: info.version, progress: 100, message: 'Обновляем интерфейс в текущем окне…' }),
    'error': (error) => {
      log(`Update error: ${error.stack || error.message}`);
      const retryAction = state.phase === 'applying' ? 'apply' : state.phase === 'downloading' ? 'download' : 'check';
      send({ phase: 'error', retryAction, message: 'Не удалось обновить приложение. Проверьте соединение и повторите.' });
    },
  };
  for (const [event, handler] of Object.entries(handlers)) updater.on(event, handler);
  send({});

  async function action(command) {
    if (!['check', 'download', 'apply'].includes(command)) throw new Error('Неизвестная команда обновления');
    if (busy) return;
    if (command === 'check' && ['downloaded', 'applying', 'staged'].includes(state.phase)) return;
    if (command === 'download' && !(state.phase === 'available' || (state.phase === 'error' && state.retryAction === 'download'))) {
      throw new Error('Сначала проверьте наличие обновления.');
    }
    if (command === 'apply' && !(state.phase === 'downloaded' || (state.phase === 'error' && state.retryAction === 'apply'))) throw new Error('Обновление ещё не скачано.');
    busy = true;
    try {
      if (command === 'check') await updater.checkForUpdates();
      else if (command === 'download') {
        send({ phase: 'downloading', progress: 0, message: 'Скачиваем обновление…' });
        await updater.downloadUpdate();
        if (state.phase === 'downloaded') await applyDownloaded();
      } else {
        await applyDownloaded();
      }
    } catch (error) {
      // electron-updater can both emit and reject the same failure.
      if (state.phase !== 'error') handlers.error(error);
    } finally { busy = false; }
  }
  async function applyDownloaded() {
    send({ phase: 'applying', message: 'Обновляем интерфейс в текущем окне…' });
    await applyInterfaceUpdate();
    send({ phase: 'staged', message: 'Интерфейс обновлён. Новая версия приложения установится при обычном закрытии и будет доступна при следующем запуске.' });
  }
  return {
    action,
    start() {
      if (startupTimer || interval) return;
      startupTimer = setTimeout(() => { void action('check'); }, 20_000);
      interval = setInterval(() => { void action('check'); }, CHECK_INTERVAL);
      startupTimer.unref?.(); interval.unref?.();
    },
    dispose() {
      clearTimeout(startupTimer); clearInterval(interval);
      for (const [event, handler] of Object.entries(handlers)) updater.removeListener(event, handler);
    },
  };
}
module.exports = { createUpdates };
