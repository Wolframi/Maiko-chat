// Native Windows capture -> persistent owner -> iframe visualizer. No recordings.
const { _electron: electron, expect } = require('playwright/test');
const { build } = require('esbuild');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  assert.equal(process.platform, 'win32');
  const root = path.resolve(__dirname, '../..');
  const sourceTitle = 'Maiko indicator audio ' + Date.now();
  const [widget, capture, css] = await Promise.all([
    build({ stdin: { resolveDir: path.join(root, 'site'), loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ScreenAudioVisualizer } from './src/components/chat/ScreenAudioVisualizer';
      export function mount(stream) {
        createRoot(document.getElementById('root')).render(<React.StrictMode><ScreenAudioVisualizer stream={stream} /></React.StrictMode>);
      }
    ` }, bundle: true, write: false, jsx: 'automatic', format: 'iife', globalName: 'signalWidget', platform: 'browser' }),
    build({ entryPoints: [path.join(root, 'site/src/lib/webrtcMedia.ts')], bundle: true, write: false,
      format: 'iife', globalName: 'captureTest', platform: 'browser' }),
    fs.readFile(path.join(root, 'site/src/app/styles/call-stage.css'), 'utf8'),
  ]);
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ok:true,desktopMediaHost:1})); return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/wanted') {
      res.end(`<title>${sourceTitle}</title><button id="tone">Play test tone</button>`); return;
    }
    if (req.url === '/ui') {
      res.end(`<style>${css}</style><div id="root"></div>`); return;
    }
    res.end('<title>Maiko indicator media owner</title><button id="capture">Share test window</button><iframe id="ui" allow="autoplay" src="/ui"></iframe>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profiles = path.join(root, 'desktop/test-output', 'indicator-' + Date.now());
  const apps = [];
  let owner;
  try {
    const playerProfile = path.join(profiles, 'player'); await fs.mkdir(playerProfile, {recursive:true});
    const playerEnv = {...process.env, MAIKO_AUDIO_TEST_URL:origin+'/wanted', MAIKO_AUDIO_TEST_PROFILE:playerProfile};
    delete playerEnv.ELECTRON_RUN_AS_NODE;
    const player = await electron.launch({executablePath:require('electron'),args:[path.join(__dirname,'fixtures/audio-player.cjs')],env:playerEnv});
    console.log('Native test source started.');
    apps.push(player);
    const tonePage = await player.firstWindow();
    await tonePage.evaluate(() => {
      document.getElementById('tone').onclick = async () => {
        if (window.testTone) { await window.testTone.resume(); return; }
        const ctx = new AudioContext(); await ctx.resume();
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        gain.gain.value = 0.01; osc.frequency.value=880;
        osc.connect(gain).connect(ctx.destination); osc.start(); window.testTone=ctx;
      };
    });
    await tonePage.getByRole('button',{name:'Play test tone'}).click();
    const appProfile = path.join(profiles,'maiko'); await fs.mkdir(appProfile,{recursive:true});
    const env = {...process.env, MAIKO_DESKTOP_TEST:'1',MAIKO_DESKTOP_URL:origin,MAIKO_DESKTOP_USER_DATA:appProfile};
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({executablePath:require('electron'),args:[path.join(root,'desktop')],env,timeout:60000});
    apps.push(app);
    const shell=await app.firstWindow();
    await shell.waitForFunction(async () => (await window.maikoDesktop.state()).phase==='ready');
    for(let i=0;i<100;i++) {
      owner=app.windows().find(page=>page.url().startsWith(origin+'/desktop-runtime'));
      if(owner)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(owner,'Permanent owner loaded');
    console.log('Native test owner started.');
    await owner.evaluate(()=>{window.maikoMediaRuntime={version:1};});
    await owner.addScriptTag({content:capture.outputFiles[0].text});
    const pickerReady=app.waitForEvent('window',{predicate:page=>page!==owner&&page!==shell});
    const captureReady=owner.evaluate(async()=>{
      window.signalStream=await window.captureTest.captureScreenShare();
    }).then(()=>null,error=>error);
    const picker=await pickerReady;
    await picker.getByRole('button',{name:'Поделиться',exact:true}).waitFor();
    const sources=await picker.evaluate(()=>window.maikoDesktop.captureSources());
    const source=sources.sources.find(source=>source.name===sourceTitle);
    assert.ok(source,'Synthetic audio app available');
    await picker.evaluate(id=>window.maikoDesktop.captureSelect({id,audio:true}),source.id).catch(error=>{if(!picker.isClosed())throw error;});
    const captureError=await captureReady;
    if(captureError)throw captureError;
    const trackState=await owner.evaluate(()=>window.signalStream.getAudioTracks().map(t=>({hint:t.contentHint,state:t.readyState,muted:t.muted})));
    console.log('Native own-share track:',JSON.stringify(trackState));
    assert.equal(trackState.length,1);
    async function mount() {
      const frame=owner.frames().find(frame=>frame.url()===origin+'/ui');
      assert.ok(frame);
      await frame.evaluate(()=>{
        window.meterContexts=[];
        const Native=window.AudioContext;
        window.AudioContext=class extends Native { constructor(...args){super(...args);window.meterContexts.push(this);} };
      });
      await frame.addScriptTag({content:widget.outputFiles[0].text});
      await frame.evaluate(()=>window.signalWidget.mount(window.parent.signalStream));
      return frame;
    }
    let frame=await mount();
    await expect(frame.locator('.screen-audio-visualizer')).toHaveAttribute('data-audio-active','true',{timeout:10000});
    console.log('Native audio reaches the iframe indicator.');
    await tonePage.evaluate(()=>window.testTone.suspend());
    await expect(frame.locator('.screen-audio-visualizer')).toHaveAttribute('data-audio-active','false');
    await tonePage.getByRole('button',{name:'Play test tone'}).click();
    try {
      await expect(frame.locator('.screen-audio-visualizer')).toHaveAttribute('data-audio-active','true',{timeout:10000});
    } catch(error) {
      console.error('Resume diagnostics:',await frame.evaluate(()=>({context:document.querySelector('.screen-audio-visualizer').dataset.audioContext,
        level:document.querySelector('.screen-audio-visualizer').style.getPropertyValue('--screen-audio-level'),visibility:document.visibilityState,
        audio:window.parent.signalStream.getAudioTracks().map(t=>({hint:t.contentHint,muted:t.muted,enabled:t.enabled,ready:t.readyState}))})));
      console.error('Player state:',await tonePage.evaluate(()=>window.testTone.state));
      throw error;
    }
    await frame.goto(origin+'/ui'); frame=await mount();
    try {
      await expect(frame.locator('.screen-audio-visualizer')).toHaveAttribute('data-audio-active','true');
    } catch(error) {
      console.error('Reload diagnostics:',await frame.evaluate(()=>({contexts:window.meterContexts.map(c=>c.state),visibility:document.visibilityState,
        audio:window.parent.signalStream.getAudioTracks().map(t=>({hint:t.contentHint,muted:t.muted,enabled:t.enabled,ready:t.readyState}))})));
      throw error;
    }
    console.log('PASS: native Windows own-share audio, silence, resume and iframe reload. No recordings.');
  } finally {
    await owner?.evaluate(()=>window.signalStream?.getTracks().forEach(track=>track.stop())).catch(()=>{});
    for(const app of apps.reverse())await app.close().catch(()=>{});
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
