const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

module.exports = async ({ outDir, artifactPaths }) => {
  if (process.platform !== 'win32') return [];
  const output = path.resolve(outDir);
  const executables = artifactPaths.filter((file) => file.toLowerCase().endsWith('.exe'));
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^win(?:-[a-z0-9]+)?-unpacked$/.test(entry.name)) continue;
    const executable = path.join(output, entry.name, 'Maiko.exe');
    if (await fs.stat(executable).catch(() => null)) executables.push(executable);
  }
  if (executables.length) {
    await run(path.join(__dirname, 'native/refresh-shell-icons.exe'), [...new Set(executables.map((file) => path.resolve(file)))], { windowsHide: true, timeout: 15_000 });
    console.log('Refreshed Windows shell icons for the built Maiko executables.');
  }
  return [];
};
