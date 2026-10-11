import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeMaikoAtoms, MaikoAtoms, MaikoMolecules, MOLECULE_RADIUS, PARTICLES_PER_MOLECULE } from "../src/lib/maikoAtoms";

test("the shipped point cloud decodes at desktop and mobile density", () => {
  const bytes = readFileSync(new URL("../public/models/maiko-atoms.bin", import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  for (const count of [6800, 4000]) {
    const model = decodeMaikoAtoms(buffer, count);
    assert.equal(model.anchors.length, count * 3);
    assert.ok(model.anchors.every(v => Number.isFinite(v) && Math.abs(v) < 1.3));
    for (let i = 0; i < model.normals.length; i += 3) {
      assert.ok(Math.abs(Math.hypot(...model.normals.subarray(i, i + 3)) - 1) < 0.001);
    }
  }
  assert.throws(() => decodeMaikoAtoms(buffer.slice(0, -1)));
  assert.throws(() => decodeMaikoAtoms(new ArrayBuffer(3)));
});

test("nearby atoms repel each other while remaining tethered to the model", () => {
  const model = new MaikoAtoms(new Float32Array([-0.003, 0, 0, 0.003, 0, 0]), new Float32Array(6));
  for (let i = 0; i < 120; i++) model.step(1 / 60, i / 60, null, 0);
  assert.ok(Math.hypot(
    model.positions[3] - model.positions[0],
    model.positions[4] - model.positions[1],
    model.positions[5] - model.positions[2],
  ) > 0.015);
  assert.ok(model.positions.every(v => Number.isFinite(v) && Math.abs(v) < 0.1));
});

test("cursor repulsion disperses atoms and springs bring them back", () => {
  const model = new MaikoAtoms(new Float32Array([0.1, 0, 0]), new Float32Array(3));
  for (let i = 0; i < 120; i++) model.step(1 / 60, i / 60, { x: 0, y: 0 }, 0);
  assert.ok(model.positions[0] > 0.15);
  for (let i = 0; i < 240; i++) model.step(1 / 60, i / 60, null, 0);
  assert.ok(Math.abs(model.positions[0] - 0.1) < 0.01);
});

test("four moving particles remain inside each sphere", () => {
  const model = new MaikoMolecules(new Float32Array([0, 0, 0]), new Float32Array(3));
  assert.equal(model.innerPositions.length, PARTICLES_PER_MOLECULE * 3);
  const initial = model.innerPositions.slice();
  for (let frame = 0; frame < 180; frame++) {
    model.step(1 / 60, frame / 60, null, 0);
    for (let k = 0; k < model.innerPositions.length; k += 3) {
      const radius = Math.hypot(...model.innerPositions.subarray(k, k + 3).map((value, axis) => value - model.positions[axis]));
      assert.ok(radius < MOLECULE_RADIUS);
    }
  }
  assert.ok(model.innerPositions.some((value, i) => Math.abs(value - initial[i]) > 0.01));
});

test("inner particles repel particles belonging to neighbouring spheres", () => {
  const nearby = new MaikoMolecules(new Float32Array([0, 0, 0, 0.04, 0, 0]), new Float32Array(6));
  const isolated = new MaikoMolecules(new Float32Array([0, 0, 0, 10, 0, 0]), new Float32Array(6));
  nearby.step(1 / 60, 0, null, 0);
  isolated.step(1 / 60, 0, null, 0);
  let netRepulsion = 0;
  for (let child = 0; child < PARTICLES_PER_MOLECULE; child++) {
    netRepulsion += nearby.innerVelocity[child * 3] - isolated.innerVelocity[child * 3];
  }
  assert.ok(netRepulsion < -0.0001, `Expected repulsion away from the neighbour, got ${netRepulsion}`);
});
