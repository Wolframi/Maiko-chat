// Build-only helper: compile all modules inside a real Electron main process.
// ELECTRON_RUN_AS_NODE uses a different V8 snapshot on modern Electron.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const bytenode = require('bytenode');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const [input, output] = process.argv.slice(2);
  for (const name of fs.readdirSync(input).filter(name => name.endsWith('.cjs'))) {
    await bytenode.compileFile({ filename: path.join(input, name),
      output: path.join(output, name.replace(/\.cjs$/, '.jsc')), compileAsModule: true,
      compress: true, sourceMap: false });
  }
  fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify({
    electron: process.versions.electron, v8: process.versions.v8,
    platform: process.platform, arch: process.arch,
  }));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
