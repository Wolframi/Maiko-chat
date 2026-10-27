const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const PIPE_ROOT = '\\\\.\\pipe\\';
const BRIDGE_NAME = /^maiko-daw-v1-([1-9][0-9]{0,9})-([0-9a-f]{16})$/;

async function dawSources() {
  if (process.platform !== 'win32') return [];
  const names = await fs.readdir(PIPE_ROOT);
  return names.filter((name) => BRIDGE_NAME.test(name)).sort().map((id) => ({
    id, processId: Number(BRIDGE_NAME.exec(id)[1]),
  }));
}

async function captureProcessState() {
  if (process.platform !== 'win32') return { parents: {}, nativeAudio: [] };
  const helper = path.join(__dirname, 'native/capture-processes.exe').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const { stdout } = await run(helper, [], { windowsHide: true, timeout: 3000, maxBuffer: 512 * 1024 });
  return JSON.parse(stdout);
}

function inProcessTree(pid, root, parents) {
  const visited = new Set();
  while (Number.isSafeInteger(pid) && pid > 0 && !visited.has(pid)) {
    if (pid === root) return true;
    visited.add(pid); pid = parents[pid];
  }
  return false;
}

// Discovery continues throughout a consented share. Its output feeds a single
// stable audio track; adding/removing a plug-in never renegotiates the call.
function watchDawAudio(scope, onPacket, { list = dawSources, state = captureProcessState,
  connect = connectDawAudio, interval = 300, log = () => {} } = {}) {
  let closed = false, polling = false;
  const connections = new Map();
  async function poll() {
    if (closed || polling) return;
    polling = true;
    try {
      const sources = await list();
      const info = sources.length ? await state() : { parents: {}, nativeAudio: [] };
      if (closed) return;
      const selected = new Map();
      for (const source of sources) {
        if (scope.ownProcessId && inProcessTree(source.processId, scope.ownProcessId, info.parents)) continue;
        if (scope.kind !== 'system' && !inProcessTree(source.processId, scope.processId, info.parents)) continue;
        // One master tap per host avoids doubling a DAW with duplicate inserts.
        if (!selected.has(source.processId)) selected.set(source.processId, source);
      }
      const ids = new Set([...selected.values()].map((source) => source.id));
      for (const [id, connection] of connections) if (!ids.has(id)) {
        connections.delete(id); connection.stop(); onPacket({ id, removed: true });
      }
      for (const source of selected.values()) {
        const nativeOutput = info.nativeAudio.some((pid) => inProcessTree(pid, source.processId, info.parents));
        const existing = connections.get(source.id);
        if (existing) {
          if (existing.nativeOutput !== nativeOutput) {
            existing.nativeOutput = nativeOutput;
            onPacket({ id: source.id, routing: true, nativeOutput });
          }
          continue;
        }
        const connection = { nativeOutput, stop: () => {} };
        connections.set(source.id, connection);
        connection.stop = connect(source.id,
          (packet) => { if (!closed && connections.get(source.id) === connection) onPacket({ ...packet, id: source.id, nativeOutput: connection.nativeOutput }); },
          () => {
            if (connections.get(source.id) !== connection) return;
            connections.delete(source.id);
            if (!closed) onPacket({ id: source.id, removed: true });
          },
          () => { if (!closed) onPacket({ id: source.id, connected: true, nativeOutput: connection.nativeOutput }); });
      }
    } catch (error) { log(`Automatic DAW discovery: ${error.message}`); }
    finally { polling = false; }
  }
  const timer = setInterval(poll, interval);
  void poll();
  return () => {
    if (closed) return;
    closed = true; clearInterval(timer);
    for (const connection of connections.values()) connection.stop();
    connections.clear();
  };
}

// Incremental, bounded decoding: pipes are byte streams on the Node side and
// headers/payloads can be split or coalesced at any byte boundary.
function createDawDecoder(onPacket) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    if (chunk.length > 1024 * 1024) throw new Error('DAW packet too large');
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 16) {
      const rate = buffered.readUInt32LE(4), frames = buffered.readUInt16LE(8);
      if (buffered.toString('ascii', 0, 4) !== 'MKDA' || rate < 8000 || rate > 384000 ||
          frames < 1 || frames > 256 || buffered.readUInt16LE(10) !== 2) throw new Error('Invalid DAW audio packet');
      const size = 16 + frames * 8;
      if (buffered.length < size) break;
      onPacket({ sampleRate: rate, samples: buffered.subarray(16, size) });
      buffered = buffered.subarray(size);
    }
  };
}

function connectDawAudio(id, onAudio, onEnd, onConnect) {
  if (!BRIDGE_NAME.test(id)) throw new Error('Invalid DAW source');
  const socket = net.createConnection(PIPE_ROOT + id);
  let ended = false, queued = [], rate, bytes = 0;
  const flush = () => {
    if (!queued.length || ended) return;
    const samples = new Uint8Array(Buffer.concat(queued, bytes));
    queued = []; bytes = 0;
    onAudio({ sampleRate: rate, samples });
  };
  const decode = createDawDecoder((packet) => {
    if (rate !== packet.sampleRate) flush();
    rate = packet.sampleRate;
    queued.push(packet.samples); bytes += packet.samples.length;
    // Bound memory even if the sender is faster than a real-time DAW.
    if (bytes >= 32 * 1024) flush();
  });
  const finish = (error) => {
    if (ended) return;
    ended = true; clearInterval(timer); clearTimeout(connecting);
    queued = []; socket.destroy(); onEnd(error);
  };
  const timer = setInterval(flush, 8);
  const connecting = setTimeout(() => finish(new Error('Не удалось подключиться к Maiko DAW Bridge. Обновите список источников.')), 5_000);
  socket.once('connect', () => { clearTimeout(connecting); onConnect?.(); });
  socket.on('data', (chunk) => { try { decode(chunk); } catch (error) { finish(error); } });
  socket.on('error', finish);
  socket.on('close', () => finish(new Error('Соединение с DAW закрыто')));
  return () => finish();
}

module.exports = { dawSources, createDawDecoder, connectDawAudio, BRIDGE_NAME,
  captureProcessState, inProcessTree, watchDawAudio };
