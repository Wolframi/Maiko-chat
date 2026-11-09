import { prepareMaikoParticleGraph, type MaikoParticleGraph } from "./maikoParticleMotion";
import { MAIKO_PARTICLE_WASM_URL } from "./maikoParticleWasmAsset";

type Exports = {
  memory: WebAssembly.Memory;
  graph_new: (count: number) => number;
  graph_data: (handle: number) => number;
  graph_result: (handle: number) => number;
  graph_contact: (handle: number) => number;
  graph_step: (handle: number) => number;
  graph_free: (handle: number) => void;
};

export function wasmGraphBuilder(instance: WebAssembly.Instance) {
  const api = instance.exports as unknown as Exports;
  if (!(api.memory instanceof WebAssembly.Memory) ||
      [api.graph_new, api.graph_data, api.graph_result, api.graph_contact, api.graph_step, api.graph_free]
        .some(value => typeof value !== "function")) throw new Error("Invalid particle graph WASM");
  function* build(data: Float32Array, count: number): Generator<void, MaikoParticleGraph> {
    if (!Number.isInteger(count) || count < 1 || count > 100000 || data.length < count * 16) {
      throw new RangeError("Invalid particle graph input");
    }
    // Shipped models decode int16 coordinates in [-4, 4). Keep cell arithmetic bounded.
    for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) {
      const value = data[i * 16 + axis];
      if (!Number.isFinite(value) || Math.abs(value) > 4) throw new RangeError("Invalid particle coordinate");
    }
    const handle = api.graph_new(count);
    if (!handle) throw new Error("Could not allocate particle graph");
    try {
      new Float32Array(api.memory.buffer, api.graph_data(handle), count * 16).set(data.subarray(0, count * 16));
      while (!api.graph_step(handle)) yield;
      // Own the result: freeing the Rust graph must not invalidate JS/GPU data.
      return {
        neighbours: new Int32Array(api.memory.buffer, api.graph_result(handle), count * 3).slice(),
        contact: api.graph_contact(handle),
      };
    } finally { api.graph_free(handle); }
  }
  return {
    create(data: Float32Array, count: number) {
      const builder = build(data, count);
      let result = builder.next();
      while (!result.done) result = builder.next();
      return result.value;
    },
    async prepare(data: Float32Array, count: number, signal?: AbortSignal) {
      const builder = build(data, count);
      try {
        for (;;) {
          signal?.throwIfAborted();
          const deadline = performance.now() + 4;
          let result = builder.next();
          while (!result.done && performance.now() < deadline) result = builder.next();
          if (result.done) return result.value;
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      } finally { builder.return(undefined as never); }
    },
  };
}

type Builder = ReturnType<typeof wasmGraphBuilder>;
// Loading starts alongside the model. A missing or slow module must not hold up the intro.
const LOAD_TIMEOUT_MS = 100;
const FETCH_TIMEOUT_MS = 4500;
let ready: Promise<Builder | null> | undefined;
let loading: Promise<Builder | null> | undefined;

/** Optional bytes come from the Electron shell's local, fixed-path IPC reader. */
export function warmMaikoParticleWasm(source?: () => Promise<Uint8Array>) {
  if (ready) return ready;
  if (typeof WebAssembly === "undefined" || (!source &&
      (typeof window === "undefined" || !/^https?:$/.test(window.location.protocol)))) return Promise.resolve(null);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  let fetchTimeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<null>(resolve => {
    timeout = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
  });
  const load = (async () => {
    let bytes: ArrayBuffer;
    if (source) bytes = new Uint8Array(await source()).buffer;
    else {
      const response = await fetch(MAIKO_PARTICLE_WASM_URL, { cache: "force-cache", signal: controller.signal });
      if (!response.ok) throw new Error("Particle WASM unavailable");
      bytes = await response.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes);
    return wasmGraphBuilder(instance);
  })().catch(() => null);
  const fetchExpired = new Promise<null>(resolve => {
    fetchTimeout = setTimeout(() => { controller.abort(); resolve(null); }, FETCH_TIMEOUT_MS);
  });
  const pending = loading = Promise.race([load, fetchExpired]).finally(() => clearTimeout(fetchTimeout));
  ready = Promise.race([pending, expired]).finally(() => clearTimeout(timeout));
  // The 100 ms UI budget is not a permanent failure. Cold IPC, fetching and
  // compilation may finish after it, while the much larger model still loads.
  void pending.then(builder => {
    if (builder && loading === pending) ready = Promise.resolve(builder);
  });
  return ready;
}

export async function prepareMaikoParticleGraphAccelerated(data: Float32Array, count: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Do not abort the shared load when one component unmounts: another may still need it.
  const warmed = warmMaikoParticleWasm();
  const pending = loading ?? warmed;
  const builder = await new Promise<Builder | null>((resolve, reject) => {
    const finish = (value: Builder | null) => {
      clearTimeout(timeout); signal?.removeEventListener("abort", abort); resolve(value);
    };
    const abort = () => {
      clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(signal?.reason);
    };
    const timeout = setTimeout(() => finish(null), LOAD_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    void pending.then(finish);
  });
  signal?.throwIfAborted();
  if (builder) {
    try {
      performance.mark('maiko-graph-rust');
      return await builder.prepare(data, count, signal);
    }
    catch {
      signal?.throwIfAborted();
      // A trapped instance must never be reused. The original JS path remains available.
      ready = Promise.resolve(null);
      loading = undefined;
    }
  }
  performance.mark('maiko-graph-js');
  return prepareMaikoParticleGraph(data, count, signal);
}
