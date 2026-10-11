const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDownloads, safeFilename, reservePath } = require('../downloads.cjs');

test('Windows filenames preserve Unicode and extensions while staying inside the downloads folder', () => {
  assert.equal(safeFilename('Отчёт (октябрь).pdf'), 'Отчёт (октябрь).pdf');
  assert.equal(safeFilename('../../Отчёт.pdf'), 'Отчёт.pdf');
  assert.equal(safeFilename('NUL.pdf'), '_NUL.pdf');
  assert.equal(safeFilename('a:bad?.txt'), 'a_bad_.txt');
  assert.equal(safeFilename('..'), 'Файл');
  const long = safeFilename('я'.repeat(300) + '.pdf');
  assert.equal(long.length, 180);
  assert.ok(long.endsWith('.pdf'));
});

test('downloads never overwrite names; reveal only completed files and restore successful history', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maiko-downloads-'));
  const directory = path.join(temporary, 'Maiko');
  const historyPath = path.join(temporary, 'downloads.json');
  const siteSession = new EventEmitter();
  const contents = { getURL: () => 'https://maiko.test/' };
  let state;
  const revealed = [];
  const options = { directory, historyPath, siteSession, getSite: () => ({ webContents: contents }), trusted: () => true,
    publish: (patch) => { state = patch.downloads; }, shell: { showItemInFolder: (target) => revealed.push(target), openPath: async () => '' }, log: () => {} };
  let controller = createDownloads(options);
  function download(name) {
    const item = Object.assign(new EventEmitter(), { getFilename: () => name, getTotalBytes: () => 10, getReceivedBytes: () => 10,
      setSavePath: (target) => { item.target = target; }, cancel: () => item.emit('done', {}, 'cancelled') });
    siteSession.emit('will-download', { preventDefault: () => assert.fail('Trusted downloads should be accepted') }, item, contents);
    return item;
  }
  try {
    const existing = reservePath(directory, 'Отчёт.pdf');
    fs.writeFileSync(existing, 'old');
    const first = download('Отчёт.pdf');
    const second = download('Отчёт.pdf');
    assert.equal(path.basename(first.target), 'Отчёт (1).pdf');
    assert.equal(path.basename(second.target), 'Отчёт (2).pdf');
    await assert.rejects(controller.action('reveal', state.entries[0].id), /ещё не скачан/);
    const secondId = state.entries[0].id;
    await controller.action('cancel', secondId);
    assert.equal(fs.existsSync(second.target), false);
    first.emit('done', {}, 'completed');
    const completed = state.entries.find((entry) => entry.phase === 'completed');
    await controller.action('reveal', completed.id);
    assert.deepEqual(revealed, [first.target]);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'old');
    await assert.rejects(controller.action('reveal', '../../outside'), /не найден/);
    const failed = download('broken.pdf');
    failed.emit('done', {}, 'interrupted');
    assert.equal(state.entries[0].phase, 'error');
    assert.equal(fs.existsSync(failed.target), false);
    let blocked = false;
    siteSession.emit('will-download', { preventDefault: () => { blocked = true; } }, first, {});
    assert.equal(blocked, true);
    controller.dispose();
    controller = createDownloads(options);
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0].path, first.target);
    fs.unlinkSync(first.target);
    await assert.rejects(controller.action('reveal', completed.id), /перемещён или удалён/);
    const paths = [];
    for (let index = 0; index < 17; index++) {
      const item = download(`Файл ${index}.pdf`);
      fs.writeFileSync(item.target, `saved-${index}`);
      paths.push(item.target); item.emit('done', {}, 'completed');
    }
    assert.equal(state.entries.length, 15);
    assert.equal(state.entries[0].name, 'Файл 16.pdf');
    assert.equal(state.entries.at(-1).name, 'Файл 2.pdf');
    assert.equal(JSON.parse(fs.readFileSync(historyPath, 'utf8')).length, 15);
    for (let index = 0; index < paths.length; index++) assert.equal(fs.readFileSync(paths[index], 'utf8'), `saved-${index}`);
    controller.dispose(); controller = createDownloads(options);
    assert.equal(state.entries.length, 15);
    assert.equal(state.entries.at(-1).name, 'Файл 2.pdf');
  } finally { controller.dispose(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
