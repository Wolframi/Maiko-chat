const api = window.maikoDownloads;
const list = document.getElementById('files');
const error = document.getElementById('error');
const rows = new Map();
const bytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.ceil(n / 1024)} КБ`;
async function action(command, id) {
  error.hidden = true;
  try { await api.action(command, id); }
  catch (failure) { error.textContent = failure.message; error.hidden = false; }
}
function render(state) {
  const files = state.entries;
  document.getElementById('count').textContent = `${files.length} / ${state.limit}`;
  document.getElementById('empty').hidden = files.length > 0;
  list.hidden = files.length === 0;
  const ids = new Set(files.map((file) => file.id));
  for (const [id, row] of rows) { if (!ids.has(id)) { row.remove(); rows.delete(id); } }
  for (const file of files) {
    let row = rows.get(file.id);
    if (!row) {
      row = document.createElement('li');
      const icon = document.createElement('span'); icon.className = 'file-icon'; icon.setAttribute('aria-hidden', 'true');
      const meta = document.createElement('div'); meta.className = 'file-meta';
      const name = document.createElement('strong'); name.className = 'file-name';
      const status = document.createElement('span'); status.className = 'file-status';
      const progress = document.createElement('progress'); progress.max = 100; progress.setAttribute('aria-label', 'Скачивание файла');
      meta.append(name, status, progress);
      const reveal = document.createElement('button');
      reveal.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v11H3ZM3 7V4h7l2 3"/></svg>';
      reveal.addEventListener('click', () => void action('reveal', file.id));
      const cancel = document.createElement('button');
      cancel.title = 'Отменить скачивание'; cancel.setAttribute('aria-label', 'Отменить скачивание');
      cancel.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      cancel.addEventListener('click', () => void action('cancel', file.id));
      row.append(icon, meta, reveal, cancel);
      row.parts = { icon, name, status, progress, reveal, cancel }; rows.set(file.id, row);
    }
    const { icon, name, status, progress, reveal, cancel } = row.parts;
    icon.textContent = file.name.includes('.') ? file.name.split('.').pop().slice(0, 4).toUpperCase() : 'ФАЙЛ';
    name.textContent = file.name; name.title = file.name;
    status.textContent = file.phase === 'completed' ? `${bytes(file.received)} · Сохранено` : file.phase === 'downloading' ? `${bytes(file.received)}${file.total ? ` / ${bytes(file.total)}` : ''} · Скачиваем…` : file.message;
    progress.hidden = file.phase !== 'downloading';
    if (file.total) progress.value = file.received / file.total * 100; else progress.removeAttribute('value');
    reveal.hidden = file.phase !== 'completed';
    reveal.title = `Открыть папку с файлом «${file.name}»`; reveal.setAttribute('aria-label', reveal.title);
    cancel.hidden = file.phase !== 'downloading'; row.dataset.phase = file.phase;
  }
  files.forEach((file, index) => {
    const row = rows.get(file.id);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
}
document.documentElement.addEventListener('pointerenter', () => void api.hover(true));
document.documentElement.addEventListener('pointerleave', () => void api.hover(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') void api.close(); });
api.onState(render);
api.onOpen(() => { error.hidden = true; });
void api.state().then(render);
