import { decodeMaikoDance } from "../../src/lib/maikoDance";
import { createMaikoParticleGraph, prepareMaikoParticleGraph, type MaikoParticleGraph } from "../../src/lib/maikoParticleMotion";
import { wasmGraphBuilder } from "../../src/lib/maikoParticleWasm";

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function equalGraph(expected: MaikoParticleGraph, actual: MaikoParticleGraph) {
  if (expected.contact !== actual.contact || expected.neighbours.length !== actual.neighbours.length) {
    throw new Error("Graph dimensions/contact differ");
  }
  for (let i = 0; i < expected.neighbours.length; i++) {
    if (expected.neighbours[i] !== actual.neighbours[i]) {
      throw new Error(`Neighbour mismatch at ${i}: JS=${expected.neighbours[i]}, Rust=${actual.neighbours[i]}`);
    }
  }
}

export async function runParticleBenchmark() {
  const bytes = await (await fetch("/graph.wasm")).arrayBuffer();
  const compileStart = performance.now();
  const { instance } = await WebAssembly.instantiate(bytes);
  const compileAndInstantiateMs = performance.now() - compileStart;
  const rust = wasmGraphBuilder(instance);
  const rows = [];
  for (const model of ["hiphop", "samba"]) {
    const buffer = await (await fetch(`/models/maiko-${model}.bin`)).arrayBuffer();
    for (const count of [14000, 40000, 84000]) {
      const decodeStart = performance.now();
      const dance = decodeMaikoDance(buffer, count);
      const decodeMs = performance.now() - decodeStart;
      const coldJsStart = performance.now();
      const expected = createMaikoParticleGraph(dance.data, dance.count);
      const firstJsMs = performance.now() - coldJsStart;
      const coldRustStart = performance.now();
      const actual = rust.create(dance.data, dance.count);
      const firstRustMs = performance.now() - coldRustStart;
      equalGraph(expected, actual);
      const jsSamplesMs: number[] = [], rustSamplesMs: number[] = [];
      const asyncJsSamplesMs: number[] = [], asyncRustSamplesMs: number[] = [];
      let jsMaxHeartbeatGapMs = 0, rustMaxHeartbeatGapMs = 0;
      const sync = {
        js: () => createMaikoParticleGraph(dance.data, dance.count),
        rust: () => rust.create(dance.data, dance.count),
      };
      for (let round = 0; round < 7; round++) {
        for (const name of round % 2 ? ["rust", "js"] as const : ["js", "rust"] as const) {
          const start = performance.now(); sync[name]();
          (name === "js" ? jsSamplesMs : rustSamplesMs).push(performance.now() - start);
        }
      }
      const asyncMethods = {
        js: () => prepareMaikoParticleGraph(dance.data, dance.count),
        rust: () => rust.prepare(dance.data, dance.count),
      };
      // The deployed path yields every ~4 ms. Measure it separately from throughput.
      for (let round = 0; round < 7; round++) {
        for (const name of round % 2 ? ["rust", "js"] as const : ["js", "rust"] as const) {
          let last = performance.now(), maxGap = 0;
          const heartbeat = setInterval(() => {
            const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now;
          }, 4);
          const start = performance.now();
          let result: MaikoParticleGraph;
          try { result = await asyncMethods[name](); } finally { clearInterval(heartbeat); }
          (name === "js" ? asyncJsSamplesMs : asyncRustSamplesMs).push(performance.now() - start);
          if (name === "js") jsMaxHeartbeatGapMs = Math.max(jsMaxHeartbeatGapMs, maxGap);
          else rustMaxHeartbeatGapMs = Math.max(rustMaxHeartbeatGapMs, maxGap);
          equalGraph(expected, result);
        }
      }
      // Cancellation must release the Rust allocation and leave later builds usable.
      const controller = new AbortController();
      controller.abort();
      try { await rust.prepare(dance.data, dance.count, controller.signal); throw new Error("Cancellation was ignored"); }
      catch (error) { if (!(error instanceof DOMException) || error.name !== "AbortError") throw error; }
      const inFlight = new AbortController();
      const pending = rust.prepare(dance.data, dance.count, inFlight.signal);
      inFlight.abort();
      let inFlightCancellationObserved = false;
      try { await pending; } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
        inFlightCancellationObserved = true;
      }
      equalGraph(expected, rust.create(dance.data, dance.count));
      const row = {
        model, count: dance.count, decodeMs, firstJsMs, firstRustMs,
        jsMs: median(jsSamplesMs), rustMs: median(rustSamplesMs),
        speedup: median(jsSamplesMs) / median(rustSamplesMs),
        asyncJsMs: median(asyncJsSamplesMs), asyncRustMs: median(asyncRustSamplesMs),
        asyncSpeedup: median(asyncJsSamplesMs) / median(asyncRustSamplesMs),
        jsMaxHeartbeatGapMs, rustMaxHeartbeatGapMs,
        jsSamplesMs, rustSamplesMs, asyncJsSamplesMs, asyncRustSamplesMs,
        exactNeighbourMatch: true, cancellationPassed: true, inFlightCancellationObserved,
      };
      rows.push(row); console.log(JSON.stringify(row));
    }
  }
  // Cover negative coordinates, duplicate positions, distance ties and hash collisions.
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
  for (const count of [1, 2, 64, 257, 1025]) {
    const data = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) {
      data[i * 16 + axis] = i % 7 === 0 ? 0 : Math.round((random() - 0.5) * 100) / 8192;
    }
    equalGraph(createMaikoParticleGraph(data, count), rust.create(data, count));
  }
  for (const count of [0, -1, 100001, 1.5]) {
    try { rust.create(new Float32Array(16), count); throw new Error("Invalid input was accepted"); }
    catch (error) { if (!(error instanceof RangeError)) throw error; }
  }
  return { userAgent: navigator.userAgent, wasmBytes: bytes.byteLength, compileAndInstantiateMs,
    rounds: 7, rows, syntheticParityCases: 5, invalidInputCases: 4,
    notes: "Same algorithm and f64 arithmetic. Timings include allocation, input/output copies, JS/WASM calls and free. Async paths both yield at a 4 ms budget. Excludes model/network transfer, GPU setup/rendering and app startup. Warmed medians; first-call times and all samples retained. Heartbeat gaps are observed maxima, not guaranteed frame budgets.",
  };
}
