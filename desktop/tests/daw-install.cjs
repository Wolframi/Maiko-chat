// Real picker IPC + native DLL install, persistent status and locked update retry.
const { _electron: electron } = require('playwright');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

async function main() {
  const output = path.resolve(__dirname, '../test-output', `vst-install-${Date.now()}`);
  await fs.mkdir(output, { recursive: true });
  const binary = process.env.MAIKO_TEST_EXECUTABLE
    ? path.join(path.dirname(process.env.MAIKO_TEST_EXECUTABLE), 'resources/app.asar.unpacked/native/Maiko DAW Bridge.vst3/Contents/x86_64-win/Maiko DAW Bridge.vst3')
    : path.resolve(__dirname, '../native/Maiko DAW Bridge.vst3/Contents/x86_64-win/Maiko DAW Bridge.vst3');
  const target = path.join(output, 'VST3/Maiko DAW Bridge.vst3/Contents/x86_64-win/Maiko DAW Bridge.vst3');
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<title>VST installer fixture</title>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let app, host;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_URL: origin,
      MAIKO_DESKTOP_USER_DATA: path.join(output, 'profile'), MAIKO_DESKTOP_DOWNLOADS_DIR: path.join(output, 'downloads'), MAIKO_DAW_PLUGIN_DIR: path.join(output, 'VST3') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120000 });
    const shell = await app.firstWindow();
    await shell.waitForFunction(async () => (await window.maikoDesktop.state()).phase === 'ready', null, { timeout: 120000 });
    let site;
    for (let attempt = 0; attempt < 100 && !site; attempt++) {
      site = app.windows().find((page) => page.url().startsWith(origin));
      if (!site) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(site);
    assert.equal(await site.evaluate(() => typeof window.maikoScreenAudio.installDawBridge), 'undefined', 'Only picker can install');
    async function open() {
      const ready = app.waitForEvent('window', { predicate: (page) => page !== site && page !== shell });
      const request = site.evaluate(async () => {
        try { const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); stream.getTracks().forEach((track) => track.stop()); return 'unexpected capture'; }
        catch (error) { return error.name; }
      });
      request.catch(() => {});
      const picker = await ready;
      await picker.locator('#sources button').first().waitFor();
      return { picker, close: async () => {
        await picker.getByRole('button', { name: 'Отмена', exact: true }).click({ noWaitAfter: true }).catch((error) => { if (!picker.isClosed()) throw error; });
        assert.ok(['NotAllowedError', 'AbortError'].includes(await request));
      } };
    }
    let selection = await open();
    let button = selection.picker.getByRole('button', { name: 'Скачать VST3', exact: true });
    await button.waitFor();
    assert.equal(await selection.picker.locator('#daw-caption').textContent(), 'Для передачи звука DAW такие как FL studio');
    await button.click();
    await selection.picker.getByRole('button', { name: '✓ Установлено', exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(target), await fs.readFile(binary));
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['Maiko DAW Bridge.vst3']);
    assert.deepEqual(await fs.readdir(path.dirname(path.dirname(target))), ['x86_64-win']);
    assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).downloads.entries.length, 0);
    await selection.close(); selection = await open();
    assert.equal(await selection.picker.getByRole('button', { name: '✓ Установлено', exact: true }).isDisabled(), true, 'Status persists across picker windows');
    await selection.close();
    // PE overlays keep the old DLL valid, but change the version checksum.
    const old = Buffer.concat([await fs.readFile(binary), Buffer.from('old test version')]);
    await fs.writeFile(target, old);
    host = spawn(path.resolve(__dirname, '../.daw-bridge-build/release/examples/test-host.exe'), [target, '48000', '32', '120'], { windowsHide: true });
    const errors = []; host.stderr.on('data', (value) => errors.push(String(value)));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Host load timed out')), 30000);
      host.once('error', reject); host.once('exit', (code) => reject(new Error(`VST host exited ${code}: ${errors.join('')}`)));
      createInterface({ input: host.stdout }).on('line', (line) => { if (JSON.parse(line).ready) { clearTimeout(timeout); resolve(); } });
    });
    selection = await open();
    await selection.picker.getByRole('button', { name: 'Скачать VST3', exact: true }).click();
    await selection.picker.getByRole('status').filter({ hasText: 'Закройте DAW' }).waitFor();
    assert.deepEqual(await fs.readFile(target), old, 'Locked plug-in remains intact');
    assert.equal(await selection.picker.getByRole('button', { name: 'Скачать VST3', exact: true }).isEnabled(), true, 'Failed install offers retry');
    const exited = new Promise((resolve) => host.once('exit', resolve)); host.kill(); await exited;
    await selection.picker.getByRole('button', { name: 'Скачать VST3', exact: true }).click();
    await selection.picker.getByRole('button', { name: '✓ Установлено', exact: true }).waitFor();
    assert.deepEqual(await fs.readFile(target), await fs.readFile(binary));
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['Maiko DAW Bridge.vst3'], 'No partial files remain');
    await selection.close();
    console.log('PASS: picker installs only VST3, no ZIP/downloads, installed status persists, locked DLL preserved, retry succeeds.');
  } finally {
    host?.kill(); await app?.close().catch(() => {});
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
