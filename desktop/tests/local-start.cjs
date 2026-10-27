const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const root = path.resolve(__dirname, '../../site');
  const output = path.resolve(__dirname, '../test-output', `local-server-${Date.now()}`);
  const project = path.join(output, 'project');
  await fs.mkdir(project, { recursive: true });
  // The real server and build run with a separate cwd/data directory.
  for (const filename of ['server.ts', 'package.json', 'tsconfig.json', 'next.config.ts']) {
    await fs.copyFile(path.join(root, filename), path.join(project, filename));
  }
  for (const folder of ['src', 'node_modules', 'public', '.next']) {
    await fs.symlink(path.join(root, folder), path.join(project, folder), 'junction');
  }
  const port = await freePort();
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: path.join(output, 'profile'), MAIKO_PROJECT_DIR: project, MAIKO_LOCAL_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..'), '--local'], env, timeout: 120_000 });
    const shell = await app.firstWindow();
    await shell.waitForFunction(() => typeof window.maikoDesktop !== 'undefined', null, { polling: 100 });
    const deadline = Date.now() + 120_000;
    let state;
    do {
      state = await shell.evaluate(() => window.maikoDesktop.state());
      if (state.phase === 'error') throw new Error(state.message);
      if (state.phase === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    } while (Date.now() < deadline);
    assert.equal(state.phase, 'ready');
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.service, undefined);
    assert.equal(state.mode, 'local');
    await app.close(); app = undefined;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }));
    console.log('Local startup passed: real custom server starts in Electron and stops on exit; separate data directory.');
  } finally { if (app) await app.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
