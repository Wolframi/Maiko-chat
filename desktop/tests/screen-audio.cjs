// Real WASAPI capture: wanted app + unrelated app + two sounds played by
// Maiko (remote voice and remote screen). Never save audio or screen frames.
const { _electron: electron } = require('playwright');
const { build } = require('esbuild');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { windowProcesses } = require('../capture-audio.cjs');

async function startTones(page, frequencies) {
  await page.evaluate((frequencies) => {
    document.getElementById('play').onclick = async () => {
      window.audioContext = new AudioContext();
      await window.audioContext.resume();
      for (const frequency of frequencies) {
        const tone = window.audioContext.createOscillator(), gain = window.audioContext.createGain();
        tone.frequency.value = frequency;
        gain.gain.value = 0.01;
        tone.connect(gain).connect(window.audioContext.destination); tone.start();
      }
    };
  }, frequencies);
  await page.getByRole('button', { name: 'Play test tones' }).click();
  await page.waitForFunction(() => window.audioContext?.state === 'running', null, { polling: 100 });
}

async function spectrum(page) {
  return page.evaluate(async () => {
    const stream = window.captured, ctx = window.audioContext;
    const track = stream.getAudioTracks()[0];
    if (!track) { stream.getTracks().forEach((entry) => entry.stop()); return { audioCount: 0, warnings: window.captureWarnings }; }
    const source = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser();
    analyser.fftSize = 8192; source.connect(analyser);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const bins = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(bins);
    const level = (frequency) => Math.max(-240, ...bins.slice(Math.floor((frequency - 15) * analyser.fftSize / ctx.sampleRate), Math.ceil((frequency + 15) * analyser.fftSize / ctx.sampleRate)));
    const cloned = track.clone();
    const result = {
      audioCount: stream.getAudioTracks().length, warnings: window.captureWarnings,
      settings: track.getSettings(), cloneRestricted: cloned.getSettings().restrictOwnAudio,
      nativeDevice: MediaStreamTrack.prototype.getSettings.call(track).deviceId,
      voice: level(550), remoteScreen: level(750), wanted: level(1100), unrelated: level(1650),
    };
    cloned.stop(); source.disconnect(); stream.getTracks().forEach((entry) => entry.stop());
    return result;
  });
}

async function main() {
  assert.equal(process.platform, 'win32', 'This checks Windows native audio isolation');
  const output = path.resolve(__dirname, '../test-output');
  const run = `audio-${Date.now()}`;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const title = req.url === '/wanted' ? 'Maiko audio test wanted' : req.url === '/unrelated' ? 'Maiko audio test unrelated' : 'Maiko audio test';
    res.end(`<html><head><title>${title}</title></head><body><button id="play">Play test tones</button></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const apps = [];
  try {
    for (const [name, tone] of [['wanted', 1100], ['unrelated', 1650]]) {
      const env = { ...process.env, MAIKO_AUDIO_TEST_URL: `${origin}/${name}`, MAIKO_AUDIO_TEST_PROFILE: path.join(output, `${run}-${name}`) };
      delete env.ELECTRON_RUN_AS_NODE;
      await fs.mkdir(env.MAIKO_AUDIO_TEST_PROFILE, { recursive: true });
      const player = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'fixtures/audio-player.cjs')], env, timeout: 120_000 });
      apps.push(player); await startTones(await player.firstWindow(), [tone]);
    }
    const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_URL: origin, MAIKO_DESKTOP_USER_DATA: path.join(output, `${run}-maiko`) };
    delete env.ELECTRON_RUN_AS_NODE;
    await fs.mkdir(env.MAIKO_DESKTOP_USER_DATA, { recursive: true });
    const app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'), args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120_000 });
    apps.push(app);
    const shell = await app.firstWindow();
    await shell.waitForFunction(async () => (await window.maikoDesktop.state()).phase === 'ready', null, { polling: 100, timeout: 60_000 });
    let site;
    for (let i = 0; i < 100 && !site; i++) {
      site = app.windows().find((page) => page.url().startsWith(origin));
      if (!site) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(site);
    await startTones(site, [550, 750]);
    const bundle = await build({ entryPoints: [path.resolve(__dirname, '../../site/src/lib/webrtcMedia.ts')], bundle: true, write: false, format: 'iife', globalName: 'screenAudioTest', platform: 'browser' });
    await site.addScriptTag({ content: bundle.outputFiles[0].text });
    assert.deepEqual(await site.evaluate(() => ({ node: typeof window.require, shell: typeof window.maikoDesktop, capture: typeof window.maikoScreenAudio.takePolicy })), { node: 'undefined', shell: 'undefined', capture: 'function' });

    async function choose(kind, { audio = true } = {}) {
      const pickerReady = app.waitForEvent('window', { predicate: (page) => page !== shell && page !== site, timeout: 30_000 });
      const request = site.evaluate(async () => {
        window.captureWarnings = [];
        window.captured = await window.screenAudioTest.captureScreenShare({ onAudioUnavailable: (message) => window.captureWarnings.push(message) });
      }).then(() => null, (error) => error);
      const picker = await pickerReady;
      await picker.getByRole('button', { name: 'Поделиться', exact: true }).waitFor();
      const { sources } = await picker.evaluate(() => window.maikoDesktop.captureSources());
      const source = kind === 'screen' ? sources.find((entry) => entry.id.startsWith('screen:')) : sources.find((entry) => entry.name === 'Maiko audio test wanted');
      assert.ok(source, `Source ${kind} found`);
      assert.equal(source.audioKind, kind === 'screen' ? 'system' : 'application');
      if (kind === 'window') {
        const owners = await windowProcesses([source]);
        assert.equal(owners[source.id.split(':')[1]], await apps[0].evaluate(() => process.pid), 'HWND resolves the actual selected app process');
      }
      await picker.getByRole('button', { name: kind === 'screen' ? `Экран ${source.name}` : source.name, exact: true }).click();
      assert.match(await picker.locator('#audio-hint').textContent(), kind === 'screen' ? /без голосов/ : /Другие приложения/);
      if (audio) await picker.getByRole('checkbox').check();
      await picker.getByRole('button', { name: 'Поделиться', exact: true }).click({ noWaitAfter: true }).catch((error) => { if (!picker.isClosed()) throw error; });
      const error = await request; if (error) throw error;
      return spectrum(site);
    }
    const screen = await choose('screen');
    console.log('Screen levels:', JSON.stringify(screen));
    assert.equal(screen.audioCount, 1); assert.equal(screen.settings.restrictOwnAudio, true); assert.equal(screen.cloneRestricted, true);
    assert.equal(screen.nativeDevice, 'loopbackWithoutChrome'); assert.deepEqual(screen.warnings, []);
    assert.ok(screen.wanted > -100 && screen.unrelated > -100, `PC audio included: ${JSON.stringify(screen)}`);
    assert.ok(screen.voice < screen.wanted - 35 && screen.remoteScreen < screen.wanted - 35, `Maiko voice and screen excluded: ${JSON.stringify(screen)}`);
    const window = await choose('window');
    console.log('Window levels:', JSON.stringify(window));
    assert.equal(window.audioCount, 1); assert.equal(window.settings.restrictOwnAudio, true); assert.equal(window.cloneRestricted, true); assert.deepEqual(window.warnings, []);
    assert.ok(window.wanted > -100, `Selected app audible: ${JSON.stringify(window)}`);
    assert.ok(Math.max(window.voice, window.remoteScreen, window.unrelated) < window.wanted - 35, `Other apps and Maiko excluded: ${JSON.stringify(window)}`);
    const silent = await choose('window', { audio: false }); assert.equal(silent.audioCount, 0);
    console.log('Audio opt-out passed.');

    // Even a forged audio=true from the picker must not capture Maiko itself.
    const ownSourceId = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      main.setTitle('Maiko audio test excluded'); main.showInactive();
      return main.getMediaSourceId();
    });
    const ownPickerReady = app.waitForEvent('window', { predicate: (page) => page !== shell && page !== site });
    const ownRequest = site.evaluate(async () => { window.captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }).then(() => null, (error) => error);
    const ownPicker = await ownPickerReady;
    const ownSources = await ownPicker.evaluate(() => window.maikoDesktop.captureSources());
    const ownSource = ownSources.sources.find((entry) => entry.id === ownSourceId);
    assert.ok(ownSource); assert.equal(ownSource.audioKind, null);
    await ownPicker.getByRole('button', { name: ownSource.name, exact: true }).click();
    assert.equal(await ownPicker.getByRole('checkbox').isDisabled(), true);
    await ownPicker.evaluate((id) => window.maikoDesktop.captureSelect({ id, audio: true }), ownSourceId).catch((error) => { if (!ownPicker.isClosed()) throw error; });
    const ownError = await ownRequest; if (ownError) throw ownError;
    assert.equal((await spectrum(site)).audioCount, 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    console.log('Own app audio exclusion enforced in main process.');

    // Cancellation clears the grant; another share can start normally.
    const pickerReady = app.waitForEvent('window', { predicate: (page) => page !== shell && page !== site });
    const cancelled = site.evaluate(async () => { try { await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); } catch (error) { return error.name; } });
    const picker = await pickerReady; await picker.getByRole('button', { name: 'Отмена', exact: true }).click({ noWaitAfter: true }).catch((error) => { if (!picker.isClosed()) throw error; });
    assert.ok(['AbortError', 'NotAllowedError'].includes(await cancelled));
    assert.equal(await site.evaluate(() => window.maikoScreenAudio.takePolicy()), null);
    const restarted = await choose('screen'); assert.equal(restarted.audioCount, 1);
    await fs.writeFile(path.join(output, `${run}-levels.json`), JSON.stringify({ screen, window, restarted }, null, 2));
    console.log('Native screen audio passed: only selected app; full PC minus remote voices and remote screens; one audio track; opt-out, clone, cancel, restart; no shell access.');
    console.log(JSON.stringify({ screen: { wanted: screen.wanted, unrelated: screen.unrelated, voice: screen.voice, remoteScreen: screen.remoteScreen }, window: { wanted: window.wanted, unrelated: window.unrelated, voice: window.voice, remoteScreen: window.remoteScreen } }));
  } finally {
    for (const app of apps.reverse()) await app.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
