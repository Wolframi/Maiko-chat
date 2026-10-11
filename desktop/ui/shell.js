const api = window.maikoDesktop;
let currentState;
const element = (id) => document.getElementById(id);

function render(state) {
  currentState = state;
  document.body.dataset.phase = state.phase;
  document.body.classList.toggle('maximized', state.maximized);
  element('status').textContent = state.phase === 'ready' ? 'Подключено' : state.phase === 'error' ? 'Нет подключения' : 'Подключаемся…';
  element('message').textContent = state.message;
  element('heading').textContent = state.phase === 'error' ? 'Не удалось подключиться' : 'Почти на месте';
  element('loader').hidden = state.phase !== 'loading';
  element('error-actions').hidden = state.phase !== 'error';
  element('connection-screen').hidden = state.phase === 'ready';
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
    const busy = ['checking', 'downloading', 'installing'].includes(update.phase);
    const command = update.phase === 'downloaded' || (update.phase === 'error' && update.retryAction === 'install') ? 'install' :
      update.phase === 'available' || (update.phase === 'error' && update.retryAction === 'download') ? 'download' : 'check';
    element('update-action').dataset.command = command;
    element('update-action').disabled = busy || update.phase === 'disabled';
    const label = busy ? update.phase === 'checking' ? 'Проверка…' : update.phase === 'installing' ? 'Перезапуск…' : `${update.progress}%` :
      update.phase === 'error' ? 'Повторить' : command === 'install' ? 'Установить' : command === 'download' ? 'Обновить' : update.phase === 'current' ? 'Обновлено' : 'Проверить';
    const description = command === 'install' ? `Перезапустить и установить ${update.version}` :
      command === 'download' ? `Скачать обновление ${update.version}` : 'Проверить обновления';
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

for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
  const grip = document.createElement('div');
  grip.className = 'resize-grip';
  grip.dataset.edge = edge;
  document.body.append(grip);
  let active = false;
  let started = false;
  let pendingPoint;
  const point = (event) => ({ x: event.screenX, y: event.screenY });
  const flush = () => {
    if (!started || !pendingPoint) return;
    api.resizeMove(pendingPoint);
    pendingPoint = undefined;
  };
  grip.addEventListener('pointerdown', async (event) => {
    if (event.button !== 0 || currentState?.maximized) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    active = true;
    started = await api.resizeStart(edge, point(event));
    if (started) {
      flush();
      if (!active) { api.resizeEnd(); started = false; }
    } else { active = false; pendingPoint = undefined; }
  });
  grip.addEventListener('pointermove', (event) => {
    if (!active) return;
    pendingPoint = point(event);
    // IPC is ordered. Send immediately instead of adding a renderer frame of
    // latency (which also stalled while the transparent window was resizing).
    flush();
  });
  const finish = () => {
    if (!active) return;
    flush();
    active = false;
    if (started) { api.resizeEnd(); started = false; }
  };
  grip.addEventListener('pointerup', finish);
  grip.addEventListener('pointercancel', finish);
  grip.addEventListener('lostpointercapture', finish);
}
