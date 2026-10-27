// Actual VST3 DLL -> Windows pipe -> automatic routing -> worklet -> WebRTC.
const { _electron: electron } = require('playwright');
const { build } = require('esbuild');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { dawSources } = require('../daw-audio.cjs');

async function main() {
  assert.equal(process.platform, 'win32');
  const output = path.resolve(__dirname, '../test-output', `daw-${Date.now()}`);
  await fs.mkdir(output, { recursive: true });
  const binary = process.env.MAIKO_TEST_EXECUTABLE
    ? path.join(path.dirname(process.env.MAIKO_TEST_EXECUTABLE), 'resources/app.asar.unpacked/native/Maiko DAW Bridge.vst3/Contents/x86_64-win/Maiko DAW Bridge.vst3')
    : path.resolve(__dirname, '../native/Maiko DAW Bridge.vst3/Contents/x86_64-win/Maiko DAW Bridge.vst3');
  const snapshot = path.join(output, 'editor-snapshot.exe');
  execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', ['/nologo', '/r:System.Drawing.dll', `/out:${snapshot}`, path.join(__dirname, 'fixtures/editor-snapshot.cs')], { windowsHide: true });
  const hosts = [], apps = [];
  function launchHost({ delay = 0, left = 1100, right = 1650, bits = 64, rate = 44100 } = {}) {
    const host = spawn(path.resolve(__dirname, '../.daw-bridge-build/release/examples/test-host.exe'),
      [binary, String(rate), String(bits), '180', 'ui', String(delay), String(left), String(right)], { windowsHide: true });
    hosts.push(host);
    const messages = [], errors = [];
    host.stderr.on('data', (value) => errors.push(String(value)));
    createInterface({ input: host.stdout }).on('line', (line) => { messages.push(JSON.parse(line)); });
    const wait = async (predicate) => {
      const start = Date.now();
      while (!messages.some(predicate)) {
        assert.equal(host.exitCode, null, `Test host alive: ${errors.join('')}`);
        assert.ok(Date.now() - start < 15000, 'Test host response');
        await new Promise((done) => setTimeout(done, 30));
      }
      return messages.find(predicate);
    };
    return { process: host, window: () => wait((entry) => entry.windowReady), ready: () => wait((entry) => entry.ready),
      command: async (value) => { const count = messages.filter((entry) => entry.command === value).length;
        host.stdin.write(`${value}\n`);
        await wait(() => messages.filter((entry) => entry.command === value).length > count); },
      image: async (name) => { const info = await wait((entry) => entry.ready);
        execFileSync(snapshot, [String(info.editor), String(host.pid), path.join(output, `${name}.png`)], { windowsHide: true }); },
    };
  }
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>${req.url === '/unrelated' ? 'Maiko unrelated application' : 'Maiko DAW integration'}</title><button id="play">Play local call</button>`);
  });
  let app, site;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_URL: origin,
      MAIKO_DESKTOP_USER_DATA: path.join(output, 'profile'), MAIKO_DESKTOP_DOWNLOADS_DIR: output, MAIKO_DAW_PLUGIN_DIR: path.join(output, 'VST3') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 60000 });
    apps.push(app);
    const shell = await app.firstWindow();
    await shell.waitForFunction(async () => (await window.maikoDesktop.state()).phase === 'ready', null, { timeout: 60000 });
    for (let i = 0; i < 100 && !site; i++) {
      site = app.windows().find((page) => page.url().startsWith(origin));
      if (!site) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(site);
    site.on('pageerror', (error) => console.error('Media page:', error));
    await site.evaluate(() => {
      document.getElementById('play').onclick = async () => {
        window.measure = new AudioContext(); await window.measure.resume();
        for (const frequency of [550, 750]) {
          const tone = window.measure.createOscillator(), gain = window.measure.createGain();
          tone.frequency.value = frequency; gain.gain.value = 0.01;
          tone.connect(gain).connect(window.measure.destination); tone.start();
        }
      };
    });
    await site.getByRole('button', { name: 'Play local call' }).click();
    await assert.rejects(() => site.evaluate(() => window.maikoScreenAudio.startDaw('forged')), /Нет разрешения/);
    const bundle = await build({ entryPoints: [path.resolve(__dirname, '../../site/src/lib/webrtcMedia.ts')], bundle: true, write: false, format: 'iife', globalName: 'captureTest', platform: 'browser' });
    await site.addScriptTag({ content: bundle.outputFiles[0].text });

    async function downloadPlugin(picker) {
      const shareBefore = await picker.locator('#share').isDisabled();
      await picker.getByRole('button', { name: 'Скачать VST3', exact: true }).click();
      await picker.getByRole('button', { name: '✓ Установлено', exact: true }).waitFor();
      assert.equal(await picker.getByRole('button', { name: '✓ Установлено', exact: true }).isDisabled(), true);
      const installed = path.join(output, 'VST3/Maiko DAW Bridge.vst3/Contents/x86_64-win/Maiko DAW Bridge.vst3');
      assert.deepEqual(await fs.readFile(installed), await fs.readFile(binary));
      assert.deepEqual(await fs.readdir(path.dirname(installed)), ['Maiko DAW Bridge.vst3']);
      assert.equal((await shell.evaluate(() => window.maikoDesktop.state())).downloads.entries.length, 0);
      assert.equal(await picker.locator('#share').isDisabled(), shareBefore);
      assert.equal(picker.isClosed(), false, 'Download keeps the source picker open');
      console.log('Only VST3 installed from the picker; no archive or Downloads entries.');
    }
    async function choose({ audio = true, download = false, window: hwnd, name } = {}) {
      const ready = app.waitForEvent('window', { predicate: (page) => page !== shell && page !== site });
      const request = site.evaluate(async () => { window.warnings = []; window.captured = await window.captureTest.captureScreenShare({ onAudioUnavailable: (message) => window.warnings.push(message) }); });
      request.catch(() => {});
      const picker = await ready;
      const { sources } = await picker.evaluate(() => window.maikoDesktop.captureSources());
      const source = sources.find((entry) => hwnd ? Number(entry.id.split(':')[1]) === hwnd : name ? entry.name === name : entry.id.startsWith('screen:'));
      assert.ok(source, `Screen/window found: ${JSON.stringify({ hwnd, name, sources: sources.map(({ id, name }) => ({ id, name })) })}`);
      assert.equal(await picker.locator('#audio-source').count(), 0);
      await picker.locator('.source').nth(sources.findIndex((entry) => entry.id === source.id)).click();
      assert.equal(await picker.locator('#daw-help, #install-daw, details').count(), 0);
      if (download) await downloadPlugin(picker);
      if (audio) await picker.getByRole('checkbox').check();
      await picker.getByRole('button', { name: 'Поделиться', exact: true }).click({ noWaitAfter: true }).catch((error) => { if (!picker.isClosed()) throw error; });
      await request;
      return site.evaluate(() => {
        window.stableTrack = window.captured.getAudioTracks()[0];
        return { count: captured.getAudioTracks().length, hint: window.stableTrack?.contentHint, warnings: window.warnings };
      });
    }
    async function stopShare() { await site.evaluate(() => { window.captured.getTracks().forEach((track) => track.stop()); window.sender?.close(); window.receiver?.close(); }); }
    async function spectrum(remote = false) {
      return site.evaluate(async (remote) => {
        const ctx = window.measure, source = ctx.createMediaStreamSource(remote ? window.remoteDaw : window.captured);
        const splitter = ctx.createChannelSplitter(2); source.connect(splitter);
        const analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
        const silent = ctx.createGain(); silent.gain.value = 0; silent.connect(ctx.destination);
        analysers.forEach((analyser, ch) => { analyser.fftSize = 8192; splitter.connect(analyser, ch); analyser.connect(silent); });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const result = analysers.map((analyser) => {
          const bins = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(bins);
          const level = (frequency) => Math.max(-240, ...bins.slice(Math.floor((frequency - 20) * analyser.fftSize / ctx.sampleRate), Math.ceil((frequency + 20) * analyser.fftSize / ctx.sampleRate)));
          return { wanted: level(1100), right: level(1650), voice: level(550), remoteScreen: level(750), otherDaw: level(2200) };
        });
        source.disconnect(); splitter.disconnect(); analysers.forEach((analyser) => analyser.disconnect()); silent.disconnect(); return result;
      }, remote);
    }
    function assertDaw(levels) {
      assert.ok(levels[0].wanted > -65 && levels[1].right > -65, `Stereo DAW audible: ${JSON.stringify(levels)}`);
      assert.ok(levels[0].right < levels[0].wanted - 25 && levels[1].wanted < levels[1].right - 25, 'Stereo separation preserved');
      assert.ok(Math.max(levels[0].voice, levels[0].remoteScreen) < levels[0].wanted - 35, `Call audio excluded: ${JSON.stringify(levels)}`);
    }
    async function waitForDaw() {
      const deadline = Date.now() + 6000;
      for (;;) {
        const levels = await spectrum();
        try { assertDaw(levels); return levels; }
        catch (error) { if (Date.now() >= deadline) throw error; }
      }
    }
    // The call already has its audio sender before the user inserts any VST.
    assert.deepEqual(await choose({ download: true }), { count: 1, hint: 'music', warnings: [] });
    await site.evaluate(async () => {
      window.sender = new RTCPeerConnection(); window.receiver = new RTCPeerConnection();
      sender.onicecandidate = ({ candidate }) => { if (candidate) void receiver.addIceCandidate(candidate); };
      receiver.onicecandidate = ({ candidate }) => { if (candidate) void sender.addIceCandidate(candidate); };
      const received = new Promise((resolve) => { receiver.ontrack = ({ track }) => { window.remoteDaw = new MediaStream([track]); resolve(); }; });
      window.originalSender = sender.addTrack(window.stableTrack, window.captured);
      const offer = await sender.createOffer(); const mid = /a=mid:(\S+)/.exec(offer.sdp)?.[1];
      offer.sdp = window.captureTest.patchOpusSdp(offer.sdp, new Set([mid]));
      await sender.setLocalDescription(offer); await receiver.setRemoteDescription(offer);
      const answer = await receiver.createAnswer(); answer.sdp = window.captureTest.patchOpusSdp(answer.sdp, new Set([mid]));
      await receiver.setLocalDescription(answer); await sender.setRemoteDescription(answer); await received;
      window.remotePlayback = new Audio(); remotePlayback.srcObject = window.remoteDaw;
      remotePlayback.volume = 0; await remotePlayback.play();
    });
    const first = launchHost(); await first.ready();
    await site.waitForFunction(() => window.receiver.connectionState === 'connected' && !window.remoteDaw.getAudioTracks()[0].muted, null, { timeout: 15000 });
    const local = await spectrum(), remote = await spectrum(true); assertDaw(local); assertDaw(remote);
    await first.image('editor-active');
    await site.evaluate(() => { if (window.stableTrack !== captured.getAudioTracks()[0] || originalSender.track !== window.stableTrack) throw Error('Audio track replaced'); });
    console.log('Late VST insertion audible locally and over existing stereo WebRTC sender:', JSON.stringify({ local, remote }));
    await first.command('pause');
    const paused = await spectrum(); assert.ok(paused.every((entry) => entry.wanted < -100 && entry.right < -100));
    await first.image('editor-silence');
    await first.command('play'); assertDaw(await spectrum());
    first.process.kill(); await new Promise((resolve) => first.process.once('exit', resolve));
    const removed = await spectrum(); assert.ok(removed.every((entry) => entry.wanted < -100 && entry.right < -100));
    assert.equal(await site.evaluate(() => stableTrack.readyState), 'live');
    const second = launchHost({ bits: 32, rate: 48000 }); await second.ready(); assertDaw(await spectrum(true));
    await site.evaluate(() => { if (originalSender.track !== stableTrack) throw Error('Sender changed after reconnect'); });
    await stopShare(); await new Promise((resolve) => setTimeout(resolve, 400)); await second.image('editor-waiting');
    // A selected DAW window is consented before the DLL even exists in it.
    const delayed = launchHost({ delay: 8 }); const window = await delayed.window();
    await choose({ window: window.window });
    assert.ok((await spectrum()).every((entry) => entry.wanted < -100 && entry.right < -100), 'Other running DAW excluded');
    await delayed.ready(); const scoped = await waitForDaw();
    await stopShare();
    // Running DAWs must never leak into an unrelated application window.
    const playerEnv = { ...process.env, MAIKO_AUDIO_TEST_URL: `${origin}/unrelated`, MAIKO_AUDIO_TEST_PROFILE: path.join(output, 'unrelated-profile') };
    delete playerEnv.ELECTRON_RUN_AS_NODE;
    const player = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'fixtures/audio-player.cjs')], env: playerEnv, timeout: 60000 }); apps.push(player);
    await (await player.firstWindow()).waitForFunction(() => document.title === 'Maiko unrelated application');
    await choose({ name: 'Maiko unrelated application' });
    const excluded = await spectrum(); assert.ok(excluded.every((entry) => entry.wanted < -100 && entry.right < -100), 'Unrelated window excludes every VST');
    await stopShare();
    // Use one host for clone lifetime checks. Mixing two independent fixtures
    // at the same frequency can legitimately cancel their opposite phases.
    await choose({ window: window.window }); assertDaw(await spectrum());
    await site.evaluate(() => { window.audioClone = stableTrack.clone(); stableTrack.stop(); });
    assert.equal(await site.evaluate(() => window.audioClone.readyState), 'live');
    await stopShare(); await site.waitForFunction(() => window.audioClone.readyState === 'ended');
    await choose({ audio: false }); assert.equal(await site.evaluate(() => captured.getAudioTracks().length), 0); await stopShare();
    const remaining = (await dawSources()).filter((entry) => hosts.some((host) => host.pid === entry.processId)); assert.equal(remaining.length, 2);
    await fs.writeFile(path.join(output, 'levels.json'), JSON.stringify({ local, remote, scoped, excluded }, null, 2));
    console.log(`PASS: automatic full-screen/window scoping, late insertion, pause/play, remove/reinsert, stable WebRTC sender, native editor, picker download, clone/stop and opt-out. ${output}`);
  } finally {
    for (const host of hosts) host.kill();
    for (const instance of apps.reverse()) await instance.close().catch(() => {});
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
