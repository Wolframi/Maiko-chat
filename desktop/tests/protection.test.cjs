const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { classMap, renameCSS, renameHTML, renameJS, obfuscate, withoutArrows } = require('../protection/transforms.cjs');

test('local CSS renaming preserves state values, IDs, filenames and DOM contracts', () => {
  const names = classMap(['.source, .error { color: red } .source:hover { color: blue }'], 'test');
  const css = renameCSS('.source.error { color: red }', names);
  const html = renameHTML('<button id="source" class="source error" data-phase="error">source</button>', names);
  const js = renameJS(`const state = 'error'; const file = 'source.js';
    button.className = 'source error'; button.classList.toggle('error', true);
    document.querySelector('.source[data-phase="error"]');`, names);
  const button = { classList: { toggle: (name, enabled) => { assert.equal(name, names.get('error')); assert.equal(enabled, true); } } };
  vm.runInNewContext(js, { button, document: { querySelector: selector => assert.equal(selector, '.' + names.get('source') + '[data-phase="error"]') } });
  assert.equal(button.className, names.get('source') + ' ' + names.get('error'));
  assert.ok(html.includes('id="source"'));
  assert.ok(html.includes('data-phase="error"'));
  assert.ok(html.includes('class="' + button.className + '"'));
  assert.ok(css.includes('.' + names.get('source') + '.' + names.get('error')));
  assert.match(js, /'error'|"error"/);
  assert.match(js, /source\.js/);
});

test('Bytenode preparation preserves lexical this without arrow functions', () => {
  const code = withoutArrows('const instance = { value: 42, method() { return () => this.value; } }; result = instance.method()();');
  assert.ok(!code.includes('=>'));
  const context = {};
  vm.runInNewContext(code, context);
  assert.equal(context.result, 42);
});

test('obfuscated site preload callback survives contextBridge serialization', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../site-preload.cjs'), 'utf8');
  let callback;
  const bridges = {};
  const electron = { ipcRenderer: {}, contextBridge: {
    exposeInMainWorld: (name, value) => { bridges[name] = value; },
    exposeInIsolatedWorld: () => {},
    executeInMainWorld: options => { callback = options.func; },
  } };
  vm.runInNewContext(obfuscate(code, { portable: true, seed: 17, id: 'site-preload' }), { require: () => electron });
  assert.equal(typeof bridges.maikoScreenAudio.takePolicy, 'function');
  const tracks = [{ stop() { this.stopped = true; } }];
  const stream = { getAudioTracks: () => tracks, removeTrack: track => { assert.ok(track.stopped); } };
  const devices = { getDisplayMedia: async () => stream };
  const target = { navigator: { mediaDevices: devices }, window: {
    maikoScreenAudio: { takePolicy: async () => ({ isolated: false }) },
  }, DOMException };
  // Electron copies the function source into a different JavaScript world.
  vm.runInNewContext('(' + callback.toString() + ')()', target);
  assert.equal(await devices.getDisplayMedia({ video: true }), stream);
});

test('obfuscated audio worklet works without browser globals or decoding helpers', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ui/daw-worklet.js'), 'utf8');
  let processor;
  vm.runInNewContext(obfuscate(source, { portable: true, seed: 17, id: 'worklet' }), {
    AudioWorkletProcessor: class { constructor() { this.port = {}; } },
    registerProcessor: (_name, type) => { processor = type; }, sampleRate: 48000,
  });
  const worklet = new processor();
  const output = [new Float32Array(128), new Float32Array(128)];
  assert.equal(worklet.process([], [output]), true);
  assert.ok(output.every(channel => channel.every(value => value === 0)));
});
