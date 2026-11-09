import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeMaikoDance } from "../src/lib/maikoDance";
import { createMaikoParticleGraph } from "../src/lib/maikoParticleMotion";
import { wasmGraphBuilder, prepareMaikoParticleGraphAccelerated } from "../src/lib/maikoParticleWasm";
import { MAIKO_PARTICLE_WASM_URL } from "../src/lib/maikoParticleWasmAsset";

const bytes = readFileSync(new URL(`../public${MAIKO_PARTICLE_WASM_URL}`, import.meta.url));

test("shipped Rust graph exactly matches JS for both models and all UI densities", async () => {
  const { instance } = await WebAssembly.instantiate(bytes);
  const rust = wasmGraphBuilder(instance);
  for (const intro of ["hiphop", "samba"]) {
    const model = readFileSync(new URL(`../public/models/maiko-${intro}.bin`, import.meta.url));
    const buffer = model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength);
    for (const count of [7000, 14000, 40000, 84000]) {
      const dance = decodeMaikoDance(buffer, count);
      assert.deepEqual(rust.create(dance.data, count), createMaikoParticleGraph(dance.data, count));
    }
  }
});

test("cancellation frees a partially built graph; concurrent results own their memory", async () => {
  const { instance } = await WebAssembly.instantiate(bytes);
  const rust = wasmGraphBuilder(instance);
  const model = readFileSync(new URL("../public/models/maiko-hiphop.bin", import.meta.url));
  const dance = decodeMaikoDance(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength));
  const controller = new AbortController();
  const cancelled = rust.prepare(dance.data, dance.count, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const [first, second] = await Promise.all([rust.prepare(dance.data, 14000), rust.prepare(dance.data, dance.count)]);
  const snapshot = second.neighbours.slice();
  assert.deepEqual(first, createMaikoParticleGraph(dance.data, 14000));
  assert.deepEqual(second, createMaikoParticleGraph(dance.data, dance.count));
  rust.create(dance.data, dance.count);
  assert.deepEqual(second.neighbours, snapshot, "Subsequent allocations must not overwrite a returned graph");
});

test("WASM validates ABI, array bounds and finite coordinates before calling Rust", async () => {
  const { instance } = await WebAssembly.instantiate(bytes);
  const rust = wasmGraphBuilder(instance);
  for (const count of [0, -1, 1.5, 100001]) assert.throws(() => rust.create(new Float32Array(16), count), RangeError);
  assert.throws(() => rust.create(new Float32Array(15), 1), RangeError);
  for (const value of [NaN, Infinity, -Infinity, 5]) {
    const data = new Float32Array(16); data[0] = value;
    assert.throws(() => rust.create(data, 1), RangeError);
  }
  assert.throws(() => wasmGraphBuilder({ exports: {} } as WebAssembly.Instance), /Invalid particle graph WASM/);
});

test("server-side preparation uses JS and preserves abort semantics", async () => {
  const data = new Float32Array(32); data[16] = 0.001;
  assert.deepEqual(await prepareMaikoParticleGraphAccelerated(data, 2), createMaikoParticleGraph(data, 2));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareMaikoParticleGraphAccelerated(data, 2, controller.signal), { name: "AbortError" });
});
