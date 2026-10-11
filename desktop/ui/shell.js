const api = window.maikoDesktop;
let currentState;
let settingsVisible = false;
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
}
async function showSettings(visible) {
  await api.toggleSettings(visible);
  settingsVisible = visible;
  element('settings-screen').hidden = !visible;
  element('form-error').textContent = '';
  if (visible) {
    element('site-url').value = currentState?.url || '';
    element('site-url').focus();
  }
}
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => {
    if (button.dataset.action === 'reload') void showSettings(false);
    void api.control(button.dataset.action);
  });
}
element('titlebar').addEventListener('dblclick', (event) => {
  if (!event.target.closest('button')) void api.control('maximize');
});
element('settings').addEventListener('click', () => void showSettings(!settingsVisible));
element('change-url').addEventListener('click', () => void showSettings(true));
element('cancel-settings').addEventListener('click', () => void showSettings(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') void showSettings(false); });
element('connection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api.connect(element('site-url').value);
    settingsVisible = false;
    element('settings-screen').hidden = true;
  } catch (error) {
    element('form-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});
api.onState(render);
void api.state().then(render);

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
