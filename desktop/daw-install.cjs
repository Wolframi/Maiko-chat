const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const NAME = 'Maiko DAW Bridge.vst3';
const run = promisify(execFile);
const unpacked = (file) => file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');

// FL Studio only discovers VST3 in the system locations. Its custom search
// paths apply to VST1/2, so the per-user VST3 location is insufficient.
function systemVst3Directory(env = process.env) {
  const common = env.CommonProgramW6432 || env.CommonProgramFiles;
  if (!common || !path.isAbsolute(common)) throw new Error('Не найдена системная папка VST3');
  return path.join(common, 'VST3');
}

async function elevate(source) {
  const checksum = createHash('sha256').update(await fs.readFile(source)).digest('hex');
  await run(unpacked(path.join(__dirname, 'native', 'install-daw-bridge.exe')), [source, checksum], { windowsHide: true });
}

function createDawInstaller({ directory = systemVst3Directory(),
  source = path.join(__dirname, 'native', NAME, 'Contents', 'x86_64-win', NAME)
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'),
  elevateInstall = elevate } = {}) {
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
        const temporary = path.join(path.dirname(target), `.maiko-${randomUUID()}.tmp`);
        try {
          let staged = false;
          try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(source, temporary);
            staged = true;
          } catch (error) {
            if (!['EACCES', 'EPERM'].includes(error.code) || path.resolve(directory) !== path.resolve(systemVst3Directory())) throw error;
            // Only the fixed system destination can request UAC. A locked DLL
            // fails at rename below and must not trigger an elevation prompt.
            await elevateInstall(source);
          }
          if (staged) await fs.rename(temporary, target);
        } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      }
      // Remove only the two companion texts shipped with old manual bundles.
      // Distribution notices remain included in the Maiko application itself.
      for (const name of ['INSTALL.txt', 'THIRD-PARTY-NOTICES.txt']) {
        await fs.unlink(path.join(bundle, 'Contents', name)).catch((error) => { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; });
      }
      if (!(await installed())) throw new Error('Не удалось проверить установленный VST3');
      return { installed: true };
    })();
    try { return await pending; }
    finally { pending = undefined; }
  }
  return { installed, install };
}
module.exports = { createDawInstaller, systemVst3Directory };
