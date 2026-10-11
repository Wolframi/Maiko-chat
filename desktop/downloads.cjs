const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const HISTORY_LIMIT = 15;

function safeFilename(value) {
  let name = String(value || 'Файл').split(/[/\\]/).pop()
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'Файл';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  const ext = path.extname(name).slice(0, 20);
  const stem = name.slice(0, name.length - path.extname(name).length);
  return stem.slice(0, 180 - ext.length) + ext;
}

function reservePath(directory, filename) {
  fs.mkdirSync(directory, { recursive: true });
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let index = 0; ; index++) {
    const target = path.join(directory, index ? `${stem} (${index})${ext}` : filename);
    try { fs.closeSync(fs.openSync(target, 'wx')); return target; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

function createDownloads({ directory, historyPath, siteSession, getSite, trusted, publish, shell, log }) {
  directory = path.resolve(directory);
  let entries = [];
  const active = new Map();
  let lastProgress = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (Array.isArray(saved)) entries = saved.filter((entry) =>
      entry && typeof entry.id === 'string' && typeof entry.path === 'string' &&
      path.dirname(path.resolve(entry.path)) === directory && entry.phase === 'completed').slice(0, HISTORY_LIMIT);
  } catch (error) { if (error.code !== 'ENOENT') log(`Download history unavailable: ${error.message}`); }
  const trimHistory = () => {
    let recent = 0;
    // Forget old records only. Downloaded files are never removed here.
    entries = entries.filter((entry) => entry.phase === 'downloading' || recent++ < HISTORY_LIMIT);
  };
  const snapshot = () => ({ directory, limit: HISTORY_LIMIT, entries: entries.slice(0, HISTORY_LIMIT).map((entry) => ({ ...entry })) });
  const send = () => publish({ downloads: snapshot() });
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      const temporary = `${historyPath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(entries.filter((entry) => entry.phase === 'completed').slice(0, HISTORY_LIMIT), null, 2));
      fs.renameSync(temporary, historyPath);
    } catch (error) { log(`Download history could not be saved: ${error.message}`); }
  };
  function willDownload(event, item, contents) {
    if (contents !== getSite()?.webContents || !trusted(contents.getURL())) { event.preventDefault(); return; }
    const entry = { id: randomUUID(), name: safeFilename(item.getFilename()), path: '',
      phase: 'downloading', received: 0, total: item.getTotalBytes(), createdAt: Date.now(), message: 'Скачиваем…' };
    entries.unshift(entry);
    try {
      entry.path = reservePath(directory, entry.name);
      entry.name = path.basename(entry.path);
      item.setSavePath(entry.path);
    } catch (error) {
      event.preventDefault();
      if (entry.path) { try { fs.unlinkSync(entry.path); } catch { /* no placeholder */ } }
      entry.phase = 'error'; entry.message = 'Не удалось сохранить файл. Проверьте доступ к папке и свободное место.';
      log(`Download setup failed: ${error.message}`); trimHistory(); send(); return;
    }
    active.set(entry.id, item);
    let interrupted = false;
    item.on('updated', (_event, status) => {
      entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes();
      if (status === 'interrupted') { interrupted = true; item.cancel(); return; }
      entry.message = 'Скачиваем…';
      if (Date.now() - lastProgress > 200) { lastProgress = Date.now(); send(); }
    });
    item.once('done', (_event, status) => {
      active.delete(entry.id);
      entry.received = item.getReceivedBytes();
      entry.phase = status === 'completed' ? 'completed' : status === 'cancelled' && !interrupted ? 'cancelled' : 'error';
      entry.message = entry.phase === 'completed' ? 'Сохранено' : entry.phase === 'cancelled' ? 'Скачивание отменено' : 'Не удалось скачать файл. Попробуйте ещё раз из чата.';
      if (status !== 'completed') {
        try { fs.unlinkSync(entry.path); } catch (error) { if (error.code !== 'ENOENT') log(`Partial download cleanup failed: ${error.message}`); }
      }
      trimHistory();
      if (status === 'completed') save();
      send();
    });
    send();
  }
  siteSession.on('will-download', willDownload);
  send();
  return {
    snapshot,
    async action(command, id) {
      if (command === 'folder') {
        fs.mkdirSync(directory, { recursive: true });
        const error = await shell.openPath(directory);
        if (error) throw new Error(error);
        return;
      }
      const entry = entries.find((entry) => entry.id === id);
      if (!entry) throw new Error('Файл не найден в загрузках.');
      if (command === 'cancel' && active.has(id)) { active.get(id).cancel(); return; }
      if (command !== 'reveal' || entry.phase !== 'completed') throw new Error('Файл ещё не скачан.');
      if (!fs.existsSync(entry.path)) throw new Error('Файл перемещён или удалён.');
      shell.showItemInFolder(entry.path);
    },
    dispose() { siteSession.removeListener('will-download', willDownload); },
  };
}

module.exports = { createDownloads, safeFilename, reservePath, HISTORY_LIMIT };
