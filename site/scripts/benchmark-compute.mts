import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { decodeMaikoDance } from "../src/lib/maikoDance";
import { createMaikoParticleGraph, MaikoParticleMotion } from "../src/lib/maikoParticleMotion";
import { peaksFromChannelData } from "../src/lib/waveform";

const require = createRequire(import.meta.url);
const { createDawDecoder } = require("../../desktop/daw-audio.cjs");
const output = new URL("../../output/rust-audit/", import.meta.url);
const rows: Record<string, unknown>[] = [];
const median = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
function measure(name: string, action: () => unknown, details: Record<string, unknown> = {}) {
  action(); // Warm this workload, then keep every timed sample.
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now(); action(); return performance.now() - start;
  });
  const row = { name, medianMs: median(samples), samplesMs: samples, ...details };
  rows.push(row); console.log(JSON.stringify(row));
}

for (const model of ["hiphop", "samba"]) {
  const bytes = await readFile(new URL(`../public/models/maiko-${model}.bin`, import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  for (const count of [14000, 40000, 84000]) {
    const dance = decodeMaikoDance(buffer, count);
    measure(`graph/${model}/${count}`, () => createMaikoParticleGraph(dance.data, dance.count));
    const motion = new MaikoParticleMotion(dance.data, dance.count);
    let time = 0;
    measure(`cpu-motion/${model}/${count}/10-frames`, () => {
      for (let frame = 0; frame < 10; frame++) motion.step(1 / 60, time++ / 60);
    }, { frames: 10 });
  }
}

const pcm = Float32Array.from({ length: 8000 * 60 * 5 }, (_, i) => Math.sin(i * 0.1) * 0.5);
measure("waveform/5-minutes-8khz", () => peaksFromChannelData(pcm, 160));

const packet = Buffer.alloc(16 + 256 * 8);
packet.write("MKDA"); packet.writeUInt32LE(48000, 4); packet.writeUInt16LE(256, 8); packet.writeUInt16LE(2, 10);
packet.fill(0, 16);
const wire = Buffer.concat(Array.from({ length: 1875 }, () => packet)); // 10 s stereo, 48 kHz.
for (const chunkSize of [packet.length * 2, 13]) {
  measure(`daw-decoder/10-seconds/chunk-${chunkSize}`, () => {
    let count = 0;
    const decode = createDawDecoder(() => { count++; });
    for (let offset = 0; offset < wire.length; offset += chunkSize) decode(wire.subarray(offset, offset + chunkSize));
    if (count !== 1875) throw new Error(`Lost DAW packets: ${count}`);
  }, { audioSeconds: 10, chunkSize, syntheticFragmentation: chunkSize === 13 });
}

type DawWorklet = { port: { onmessage: (event: unknown) => void }; process: (inputs: unknown[], outputs: Float32Array[][]) => boolean };
let Worklet!: new () => DawWorklet;
const workletCode = await readFile(new URL("../../desktop/ui/daw-worklet.js", import.meta.url), "utf8");
new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", workletCode)(
  class { port = {}; }, (_name: string, constructor: typeof Worklet) => { Worklet = constructor; }, 48000,
);
for (const rate of [44100, 48000, 96000, 192000]) {
  const frames = Math.ceil(128 * rate / 48000);
  const samples = Float32Array.from({ length: frames * 2 }, (_, i) => Math.sin(i * 0.1) * 0.1);
  const warmup = new Float32Array(Math.ceil(rate * 0.04) * 2);
  const outputChannels = [new Float32Array(128), new Float32Array(128)];
  measure(`daw-worklet/10-seconds/${rate}hz`, () => {
    const worklet = new Worklet();
    worklet.port.onmessage({ data: { sampleRate: rate, samples: warmup } });
    for (let quantum = 0; quantum < 3750; quantum++) {
      worklet.port.onmessage({ data: { sampleRate: rate, samples } });
      worklet.process([], [outputChannels]);
    }
  }, { audioSeconds: 10, includesFeed: true });
}

await mkdir(output, { recursive: true });
await writeFile(new URL("baseline.json", output), JSON.stringify({
  measuredAt: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(),
  cpu: cpus()[0]?.model, logicalCpus: cpus().length,
  notes: "Isolated compute timings, not application latency; one warmup + seven samples. CPU motion is the fallback, not the GPU path. Audio excludes IPC, OS capture, encoding and network.",
  rows,
}, null, 2) + "\n");
