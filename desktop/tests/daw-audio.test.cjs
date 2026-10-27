const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDawDecoder, BRIDGE_NAME, inProcessTree, watchDawAudio } = require('../daw-audio.cjs');

test('process scopes include bridged child hosts, exclude siblings, and terminate cycles', () => {
  const parents = { 11: 10, 12: 11, 20: 1, 21: 20, 30: 31, 31: 30 };
  assert.equal(inProcessTree(12, 10, parents), true);
  assert.equal(inProcessTree(10, 10, parents), true);
  assert.equal(inProcessTree(21, 10, parents), false);
  assert.equal(inProcessTree(30, 10, parents), false);
});

async function until(predicate) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < 2000, 'Automatic discovery completed');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
test('live discovery handles late insertion, routing changes, removal, reconnect and stop', async () => {
  let sources = [], nativeAudio = [], calls = [], stopped = [];
  const packets = [];
  const stop = watchDawAudio({ kind: 'application', processId: 10, ownProcessId: 90 }, (value) => packets.push(value), {
    interval: 5, list: async () => sources,
    state: async () => ({ parents: { 11: 10, 21: 20, 91: 90 }, nativeAudio }),
    connect: (id, audio, end, connected) => {
      const connection = { id, audio, end }; calls.push(connection); connected();
      return () => { stopped.push(connection); end(); };
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(calls.length, 0);
    sources = [{ id: 'child', processId: 11 }, { id: 'duplicate', processId: 11 },
      { id: 'unrelated', processId: 21 }, { id: 'own-app', processId: 91 }];
    await until(() => calls.length === 1); assert.equal(calls[0].id, 'child');
    calls[0].audio({ samples: new Uint8Array(8) });
    assert.equal(packets.at(-1).nativeOutput, false);
    nativeAudio = [11];
    await until(() => packets.some((entry) => entry.routing && entry.nativeOutput));
    sources = [];
    await until(() => stopped.length === 1);
    assert.ok(packets.some((entry) => entry.removed && entry.id === 'child'));
    sources = [{ id: 'new-insert', processId: 10 }];
    await until(() => calls.length === 2);
    calls[1].end(new Error('Pipe disconnected'));
    await until(() => calls.length === 3);
    stop(); const count = packets.length;
    calls[2].audio({ samples: new Uint8Array(8) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(packets.length, count); assert.equal(calls.length, 3);
  } finally { stop(); }
});
test('full screen includes every DAW except the app; pending discovery cannot connect after stop', async () => {
  const ids = [];
  const stop = watchDawAudio({ kind: 'system', ownProcessId: 90 }, () => {}, {
    interval: 5, list: async () => [{ id: 'a', processId: 10 }, { id: 'b', processId: 20 }, { id: 'own', processId: 91 }],
    state: async () => ({ parents: { 91: 90 }, nativeAudio: [] }),
    connect: (id) => { ids.push(id); return () => {}; },
  });
  await until(() => ids.length === 2); stop(); assert.deepEqual(ids, ['a', 'b']);
  let resolve;
  const cancel = watchDawAudio({ kind: 'system' }, () => {}, {
    list: () => new Promise((done) => { resolve = done; }),
    state: async () => ({ parents: {}, nativeAudio: [] }), connect: () => assert.fail('Cancelled discovery connected'),
  });
  cancel(); resolve([{ id: 'late', processId: 1 }]);
  await new Promise((done) => setImmediate(done));
});

function packet(rate = 44100, frames = 256) {
  const bytes = Buffer.alloc(16 + frames * 8);
  bytes.write('MKDA'); bytes.writeUInt32LE(rate, 4); bytes.writeUInt16LE(frames, 8); bytes.writeUInt16LE(2, 10);
  for (let i = 0; i < frames; i++) { bytes.writeFloatLE(0.25, 16 + i * 8); bytes.writeFloatLE(-0.5, 20 + i * 8); }
  return bytes;
}
test('DAW framing survives split headers, split floats and multiple packets per read', () => {
  const packets = [], decode = createDawDecoder((value) => packets.push(value));
  const bytes = Buffer.concat([packet(), packet(96000, 31)]);
  for (let offset = 0; offset < bytes.length; offset += 13) decode(bytes.subarray(offset, offset + 13));
  assert.deepEqual(packets.map(({ sampleRate, samples }) => [sampleRate, samples.length]), [[44100, 2048], [96000, 248]]);
  assert.equal(packets[0].samples.readFloatLE(0), 0.25);
  assert.equal(packets[0].samples.readFloatLE(4), -0.5);
  decode(Buffer.concat([packet(), packet()])); assert.equal(packets.length, 4);
});
test('DAW decoding rejects malformed lengths, rates, formats and arbitrary paths', () => {
  for (const change of [(b) => b.write('BAD!'), (b) => b.writeUInt32LE(0, 4),
    (b) => b.writeUInt16LE(65535, 8), (b) => b.writeUInt16LE(1, 10)]) {
    const bytes = packet(); change(bytes);
    assert.throws(() => createDawDecoder(() => {})(bytes), /Invalid DAW/);
  }
  assert.equal(BRIDGE_NAME.test('maiko-daw-v1-1234-0123456789abcdef'), true);
  for (const id of ['\\\\server\\pipe\\audio', '../audio', 'maiko-daw-v1-0-0123456789abcdef', 'maiko-daw-v1-1-0123456789abcdef/extra']) assert.equal(BRIDGE_NAME.test(id), false);
});

function worklet() {
  let Constructor;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/daw-worklet.js'), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = {}; } }, Float32Array, sampleRate: 48000,
    registerProcessor: (_name, value) => { Constructor = value; },
  });
  return new Constructor();
}
for (const rate of [44100, 48000, 96000, 192000]) test(`DAW worklet preserves stereo and resamples ${rate} Hz to 48 kHz`, () => {
  const node = worklet(); let sent = 0, rendered = 0, squaredError = 0;
  const feed = (frames) => {
    const samples = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      samples[i * 2] = Math.sin((sent + i) / rate * 1100 * Math.PI * 2) * 0.1;
      samples[i * 2 + 1] = Math.sin((sent + i) / rate * 1650 * Math.PI * 2) * 0.1;
    }
    sent += frames; node.port.onmessage({ data: { sampleRate: rate, samples } });
  };
  feed(Math.ceil(rate * 0.04));
  for (let quantum = 0; quantum < 50; quantum++) {
    feed(Math.ceil(128 * rate / 48000));
    const channels = [new Float32Array(128), new Float32Array(128)];
    assert.equal(node.process([], [channels]), true);
    for (let i = 0; i < 128; i++) {
      for (let ch = 0; ch < 2; ch++) squaredError += (channels[ch][i] - Math.sin((rendered + i) / 48000 * (ch ? 1650 : 1100) * Math.PI * 2) * 0.1) ** 2;
    }
    rendered += 128;
  }
  assert.ok(Math.sqrt(squaredError / (rendered * 2)) < 0.001, 'stereo tone matches resampled waveform');
});
test('DAW worklet silences underruns, rejects NaNs and bounds backlog', () => {
  const node = worklet();
  node.port.onmessage({ data: { sampleRate: 48000, samples: new Float32Array(2000).fill(NaN) } });
  let channels = [new Float32Array(128), new Float32Array(128)]; node.process([], [channels]);
  assert.ok(channels.every((channel) => channel.every((sample) => sample === 0)));
  for (let i = 0; i < 200; i++) node.port.onmessage({ data: { sampleRate: 48000, samples: new Float32Array(2048).fill(0.2) } });
  assert.ok(node.write - node.read <= 48000 * 0.12);
  for (let i = 0; i < 100; i++) { channels = [new Float32Array(128), new Float32Array(128)]; node.process([], [channels]); }
  assert.ok(channels.every((channel) => channel.every((sample) => sample === 0)));
});
