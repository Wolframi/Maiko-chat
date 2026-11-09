import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeMaikoDance } from "../src/lib/maikoDance";
import { createMaikoParticleGraph } from "../src/lib/maikoParticleMotion";
import { decodeMaikoParticleGraph, encodeMaikoParticleGraph, particleChecksum } from "../src/lib/maikoParticleGraphBinary";
import { MAIKO_PARTICLE_GRAPH_ASSETS } from "../src/lib/maikoParticleGraphAssets";

const buffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;

test("every shipped binary exactly matches the graph for its model and density", () => {
  for (const [intro, model] of Object.entries(MAIKO_PARTICLE_GRAPH_ASSETS)) {
    const input = buffer(readFileSync(new URL(`../public/models/maiko-${intro}.bin`, import.meta.url)));
    assert.equal(input.byteLength, model.bytes);
    assert.equal(particleChecksum(input), model.checksum);
    for (const [density, asset] of Object.entries(model.graphs)) {
      const count = Number(density), dance = decodeMaikoDance(input, count);
      const bytes = buffer(readFileSync(new URL(`../public${asset.asset}`, import.meta.url)));
      assert.equal(createHash("sha256").update(new Uint8Array(bytes)).digest("hex"), asset.sha256);
      assert.equal(particleChecksum(bytes), asset.checksum);
      const expected = createMaikoParticleGraph(dance.data, count);
      assert.deepEqual(decodeMaikoParticleGraph(bytes, count), expected);
      assert.deepEqual(encodeMaikoParticleGraph(expected), bytes);
    }
  }
});

test("binary decoder rejects truncated, mismatched and malformed graphs", () => {
  const data = new Float32Array(32); data[16] = 0.001;
  const bytes = encodeMaikoParticleGraph(createMaikoParticleGraph(data, 2));
  assert.throws(() => decodeMaikoParticleGraph(bytes.slice(0, -1), 2));
  assert.throws(() => decodeMaikoParticleGraph(bytes, 1));
  for (const [offset, value] of [[0, 0], [4, 2], [8, 3], [12, 1], [24, -2], [24, 2], [24, 0]]) {
    const bad = bytes.slice(0); new DataView(bad).setInt32(offset, value, true);
    assert.throws(() => decodeMaikoParticleGraph(bad, 2));
  }
  const bad = bytes.slice(0); new DataView(bad).setFloat64(16, NaN, true);
  assert.throws(() => decodeMaikoParticleGraph(bad, 2));
  assert.equal(particleChecksum(new TextEncoder().encode("123456789").buffer), 0xcbf43926);
});
