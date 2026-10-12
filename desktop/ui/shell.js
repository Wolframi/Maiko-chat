const api = window.maikoDesktop;
const element = (id) => document.getElementById(id);

function render(state) {
  document.body.dataset.phase = state.phase;
  document.body.classList.toggle('maximized', state.maximized);
  element('status').textContent = state.phase === 'ready' ? 'Подключено' : state.phase === 'error' ? 'Нет подключения' : 'Подключаемся…';
  element('message').textContent = state.message;
  element('heading').textContent = state.phase === 'error' ? 'Не удалось подключиться' : 'Почти на месте';
  element('loader').hidden = state.phase !== 'loading';
  element('error-actions').hidden = state.phase !== 'error';
  element('connection-screen').hidden = state.phase === 'ready';
  const sitePhase = state.siteUpdatePhase || 'idle';
  element('site-update-dock').hidden = sitePhase === 'idle';
  element('site-update-dock').dataset.phase = sitePhase;
  element('site-update-label').textContent = sitePhase === 'loading' ? 'Сайт обновляется…' : sitePhase === 'ready' ? 'Сайт обновлён' : sitePhase === 'error' ? 'Не удалось обновить сайт' : '';
  element('site-update-retry').hidden = sitePhase !== 'error';
  element('maximize').title = state.maximized ? 'Восстановить' : 'Развернуть';
  element('maximize').setAttribute('aria-label', element('maximize').title);
  const files = state.downloads?.entries || [];
  const pending = files.filter((file) => file.phase === 'downloading');
  element('downloads-count').hidden = pending.length === 0;
  element('downloads-count').textContent = pending.length;
  element('downloads-action').title = pending.length ? `Открыть папку загрузок. Скачиваем: ${pending.length}` : 'Открыть папку загрузок';
  element('downloads-status').textContent = files[0] ? `${files[0].name}: ${files[0].message}` : '';
  const update = state.update;
  if (update) {
    element('app-version').textContent = `v${update.currentVersion}`;
    element('app-version').title = `Версия приложения ${update.currentVersion}`;
    element('update-status').textContent = update.message;
    element('update-dock').dataset.phase = update.phase;
    element('update-dock').title = update.message;
    const busy = ['checking', 'downloading', 'downloaded', 'installing'].includes(update.phase);
    const command = update.phase === 'error' && update.retryAction === 'apply' ? 'apply' :
      update.phase === 'available' || (update.phase === 'error' && update.retryAction === 'download') ? 'download' : 'check';
    element('update-action').dataset.command = command;
    element('update-action').disabled = busy || update.phase === 'disabled';
    const label = busy ? update.phase === 'checking' ? 'Проверка…' : ['downloaded', 'installing'].includes(update.phase) ? 'Установка…' : `${update.progress}%` :
      update.phase === 'error' ? 'Повторить' : command === 'download' ? 'Обновить' : update.phase === 'current' ? 'Обновлено' : 'Проверить';
    const description = command === 'apply' ? 'Повторить установку обновления' :
      command === 'download' ? `Обновить до версии ${update.version} с автоматическим перезапуском` : 'Проверить обновления';
    element('update-label').textContent = label;
    element('update-action').setAttribute('aria-label', busy ? update.message : description);
    element('update-action').title = update.phase === 'disabled' ? update.message : `${description}. ${update.message}`;
    element('update-progress').hidden = update.phase !== 'downloading';
    element('update-progress').value = update.progress;
  }
}
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => {
    void api.control(button.dataset.action);
  });
}
element('titlebar').addEventListener('dblclick', (event) => {
  if (!event.target.closest('button')) void api.control('maximize');
});
element('update-action').addEventListener('click', async () => {
  try { await api.update(element('update-action').dataset.command || 'check'); }
  catch (error) {
    element('update-status').textContent = error.message;
    element('update-dock').title = error.message;
  }
});
api.onState(render);
void api.state().then(render);
element('downloads-action').addEventListener('click', async () => {
  try { await api.downloadsPanel(false); await api.downloads('folder'); }
  catch (error) {
    element('downloads-status').textContent = error.message;
    element('downloads-action').title = error.message;
  }
});
const downloadsButton = element('downloads-action');
function showDownloadsPanel() {
  const { x, width } = downloadsButton.getBoundingClientRect();
  void api.downloadsPanel(true, { x, width });
}
downloadsButton.addEventListener('pointerenter', showDownloadsPanel);
downloadsButton.addEventListener('pointerleave', () => void api.downloadsPanel(false));
downloadsButton.addEventListener('focus', showDownloadsPanel);
downloadsButton.addEventListener('blur', () => void api.downloadsPanel(false));
api.onDownloadsPanel((open) => downloadsButton.setAttribute('aria-expanded', String(open)));
