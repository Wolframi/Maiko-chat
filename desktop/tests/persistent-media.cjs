// Local integration: real call and real display capture. Never save frames.
const { _electron: electron, chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');

const base = process.env.PULSE_BASE_URL || 'http://127.0.0.1:3100';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Use a local test server with SEED_DEMO=1');
async function login(view, username, password) {
  await view.getByPlaceholder('artem').fill(username);
  await view.locator('input[type="password"]').fill(password);
  await view.getByRole('button', { name: 'Войти', exact: true }).click();
  await view.locator('.workspace').waitFor({ timeout: 30_000 });
  const end = view.getByRole('button', { name: /^Завершить(?: звонок)?$/ });
  if (await end.count()) await end.click();
}
async function main() {
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.desktopMediaHost, 1);
  // Electron's local-asset protocol uses net.fetch, so a page-level CDP route
  // cannot replace its health response. Simulate publication at a local HTTP
  // proxy while forwarding the real app, signaling and media requests.
  let simulateDeployment = false;
  const target = new URL(base);
  const connections = new Set();
  const proxy = http.createServer((request, response) => {
    if (new URL(request.url, target).searchParams.get('_b') === 'screen-update-test') simulateDeployment = false;
    if (request.url === '/api/health' && simulateDeployment) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...health, buildId: 'screen-update-test' }));
      return;
    }
    const upstream = http.request(new URL(request.url, target), { method: request.method,
      headers: { ...request.headers, host: target.host } }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  proxy.on('connection', socket => { connections.add(socket); socket.on('error', () => {}); socket.on('close', () => connections.delete(socket)); });
  proxy.on('upgrade', (request, socket, head) => {
    const upstream = http.request(new URL(request.url, target), { headers: { ...request.headers, host: target.host } });
    upstream.on('upgrade', (response, peer, peerHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n');
      if (head.length) peer.write(head);
      if (peerHead.length) socket.write(peerHead);
      peer.pipe(socket); socket.pipe(peer);
      socket.on('close', () => peer.destroy()); peer.on('error', () => socket.destroy());
    });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const testBase = `http://127.0.0.1:${proxy.address().port}`;
  const profile = path.resolve(__dirname, '../test-output/persistent-media-' + Date.now());
  await fs.mkdir(profile, { recursive: true });
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: profile, MAIKO_DESKTOP_URL: testBase };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, browser, site;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const remoteContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const remote = await remoteContext.newPage();
    await remote.goto(testBase);
    await login(remote, 'alice', 'Alice1234!');
    app = await electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..'), '--use-fake-device-for-media-stream'], env, timeout: 60_000 });
    const shell = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    for (let attempt = 0; attempt < 100; attempt++) {
      site = app.windows().find(page => page.url().startsWith(testBase + '/desktop-runtime'));
      if (site) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(site, 'The permanent media document loaded');
    const ui = site.frameLocator('iframe[data-maiko-desktop-ui]');
    await login(ui, 'artem', 'Artem1234!');
    console.log('Persistent owner and embedded UI authenticated.');
    await ui.getByRole('button', { name: 'Люди', exact: true }).click();
    await ui.getByRole('button', { name: /Алиса.*@alice/ }).click();
    await remote.getByRole('button', { name: 'Люди', exact: true }).click();
    await remote.getByRole('button', { name: /Artem.*@artem/ }).click();
    await ui.getByRole('button', { name: 'Звонок', exact: true }).click();
    await remote.getByRole('button', { name: 'Ответить', exact: true }).click();
    await site.waitForFunction(() => window.maikoMediaRuntime?.getSnapshot()?.call.status === 'На линии', null, { timeout: 30_000 });
    console.log('Local call connected.');
    await site.evaluate(() => {
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async options => {
        window.captureDebug = { active: navigator.userActivation.isActive, focus: document.hasFocus() };
        try { return await original(options); }
        catch (error) { window.captureDebug.error = error.name + ': ' + error.message; throw error; }
      };
    });
    const pickerReady = app.waitForEvent('window', { predicate: page => page !== site && page !== shell, timeout: 20_000 });
    await ui.getByRole('button', { name: 'Демонстрация экрана', exact: true }).click();
    const picker = await pickerReady.catch(async error => {
      console.error(await site.evaluate(() => ({ capture: window.captureDebug, status: window.maikoMediaRuntime.getSnapshot().call.status })));
      throw error;
    });
    await picker.waitForFunction(() => window.maikoDesktop?.captureSources);
    const sources = await picker.evaluate(() => window.maikoDesktop.captureSources());
    const source = sources.sources.find(entry => entry.id.startsWith('screen:'));
    assert.ok(source, 'A display is available');
    await picker.evaluate(id => window.maikoDesktop.captureSelect({ id, audio: false }), source.id).catch(error => { if (!picker.isClosed()) throw error; });
    await site.waitForFunction(() => window.maikoMediaRuntime?.getSnapshot()?.call.sharingScreen, null, { timeout: 20_000 });
    console.log('Original display capture is live.');
    const before = await site.evaluate(() => {
      const call = window.maikoMediaRuntime.getSnapshot().call;
      window.screenBeforeUpdate = call.localStream.getVideoTracks().find(track => track.contentHint === 'detail');
      window.audioBeforeUpdate = document.querySelector('audio');
      return { callId: call.active.callId, track: window.screenBeforeUpdate.id };
    });
    await remote.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.videoWidth > 0), null, { timeout: 20_000 });

    let ownerNavigations = 0;
    await site.evaluate(() => {
      window.uiDocumentLoads = 0;
      document.querySelector('iframe[data-maiko-desktop-ui]').addEventListener('load', () => { window.uiDocumentLoads++; });
    });
    site.on('framenavigated', frame => {
      if (frame === site.mainFrame()) ownerNavigations++;
    });
    simulateDeployment = true;
    await shell.getByText('Сайт обновляется…', { exact: true }).waitFor({ timeout: 15_000 });
    await site.waitForFunction(() => sessionStorage.getItem('pulse-boot-id') === 'screen-update-test', null, { timeout: 15_000 });
    await site.waitForFunction(() => window.uiDocumentLoads === 1, null, { timeout: 20_000 });
    await ui.locator('.workspace').waitFor({ timeout: 30_000 });
    await shell.getByText('Сайт обновлён', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await ui.locator('.boot__update').count(), 0, 'Update text belongs to the top desktop dock');
    const after = await site.evaluate(() => {
      const call = window.maikoMediaRuntime.getSnapshot().call;
      const screen = call.localStream.getVideoTracks().find(track => track.contentHint === 'detail');
      return { callId: call.active.callId, track: screen.id, sameTrack: screen === window.screenBeforeUpdate,
        live: screen.readyState, sharing: call.sharingScreen, sameAudioElement: document.querySelector('audio') === window.audioBeforeUpdate };
    });
    assert.equal(after.callId, before.callId);
    assert.equal(after.track, before.track);
    assert.equal(after.sameTrack, true);
    assert.equal(after.live, 'live');
    assert.equal(after.sharing, true);
    assert.equal(after.sameAudioElement, true);
    assert.equal(ownerNavigations, 0);
    assert.equal(await site.evaluate(() => window.uiDocumentLoads), 1);
    assert.equal(await ui.getByText('Сайт обновился — обновите сайт').count(), 0);
    assert.ok(await ui.getByRole('button', { name: 'Остановить демонстрацию', exact: true }).count());
    // Repeated ready reports must not cancel the countdown or keep the dock visible.
    await site.evaluate(() => window.maikoMediaRuntime.reportSiteUpdate('ready'));
    await shell.locator('#site-update-dock').waitFor({ state: 'hidden', timeout: 10_000 });
    const uiLoadedAt = await site.evaluate(() => document.querySelector('iframe[data-maiko-desktop-ui]').contentWindow.performance.timeOrigin);
    await shell.evaluate(() => window.maikoDesktop.control('reload'));
    await site.waitForFunction(previous => {
      const frame = document.querySelector('iframe[data-maiko-desktop-ui]');
      return frame?.contentWindow.performance.timeOrigin !== previous && frame?.contentDocument.querySelector('.workspace');
    }, uiLoadedAt, { timeout: 30_000 });
    await ui.locator('.workspace').waitFor({ timeout: 30_000 });
    assert.equal(await site.evaluate(() => window.screenBeforeUpdate.readyState), 'live');
    assert.equal(ownerNavigations, 0);
    await ui.getByRole('button', { name: /^Завершить(?: звонок)?$/ }).click();
    console.log('PASS: server update and manual UI refresh preserve the original screen track, call ID and audio owner; no recapture or call leave.');
  } finally {
    await site?.evaluate(() => window.maikoMediaRuntime?.getSnapshot()?.call.endCall()).catch(() => {});
    await app?.close().catch(() => {}); await browser?.close().catch(() => {});
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
