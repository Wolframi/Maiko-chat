const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const NAME = 'Maiko DAW Bridge.vst3';

function createDawInstaller({ directory = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Common', 'VST3'),
  source = path.join(__dirname, 'native', NAME, 'Contents', 'x86_64-win', NAME)
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2') } = {}) {
  const bundle = path.join(directory, NAME);
  const target = path.join(bundle, 'Contents', 'x86_64-win', NAME);
  let pending;
  async function installed() {
    const [current, previous] = await Promise.all([fs.readFile(source), fs.readFile(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })]);
    return previous !== null && current.equals(previous);
  }
  async function install() {
    if (pending) return pending;
    pending = (async () => {
      if (!path.isAbsolute(directory)) throw new Error('Не найдена папка VST3');
      if (!(await installed())) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = path.join(path.dirname(target), `.maiko-${randomUUID()}.tmp`);
        try {
          await fs.copyFile(source, temporary);
          // Replacement fails while a DAW holds the old module. Preserve it.
          await fs.rename(temporary, target);
        } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      }
      // Remove only the two companion texts shipped with old manual bundles.
      // Distribution notices remain included in the Maiko application itself.
      for (const name of ['INSTALL.txt', 'THIRD-PARTY-NOTICES.txt']) {
        await fs.unlink(path.join(bundle, 'Contents', name)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
      if (!(await installed())) throw new Error('Не удалось проверить установленный VST3');
      return { installed: true };
    })();
    try { return await pending; }
    finally { pending = undefined; }
  }
  return { installed, install };
}
module.exports = { createDawInstaller };
