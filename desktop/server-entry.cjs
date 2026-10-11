// Runs in Electron's separate Node utility process, never in a renderer.
const path = require('node:path');
const root = process.argv[2];
process.chdir(root);
require(path.join(root, 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs'));
if (process.parentPort) {
  process.parentPort.on('message', ({ data }) => {
    if (data === 'shutdown') process.emit('SIGTERM');
  });
}
require(path.join(root, 'server.ts'));
