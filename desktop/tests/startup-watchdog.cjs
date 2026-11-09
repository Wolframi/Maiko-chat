const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

async function main() {
  const output = path.resolve(__dirname, '../test-output', `watchdog-${Date.now()}`);
  await fs.mkdir(output, { recursive: true });
  const entry = path.join(output, 'delayed-shell.cjs');
  // Delay the local shell beyond the old watchdog, without modifying app files
  // or relying on a particular GPU/antivirus slowdown to reproduce the race.
  await fs.writeFile(entry, `
    const electron = require('electron');
    const load = electron.BrowserWindow.prototype.loadURL;
    electron.BrowserWindow.prototype.loadURL = function(url, ...args) {
      return new Promise((resolve, reject) => {
        setTimeout(() => load.call(this, url, ...args).then(resolve, reject), 16000);
      });
    };
    require(${JSON.stringify(path.resolve(__dirname, '../main.cjs'))});
  `);
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>Ready</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: path.join(output, 'user'),
    MAIKO_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/app` };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [entry], env, timeout: 60000 });
    const shell = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await shell.waitForFunction(() => document.body.dataset.phase === 'ready', null, { timeout: 60000 });
    const played = await shell.evaluate(() => Date.now() - Number(document.querySelector('#startup-model').dataset.startedAt));
    assert.ok(played >= 2900 && played < 5000, `Cold shell should retain its three-second intro, got ${played} ms`);
    console.log(`Delayed shell passed: 16-second initialization, then ${played} ms of animation.`);
  } finally {
    await app?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
