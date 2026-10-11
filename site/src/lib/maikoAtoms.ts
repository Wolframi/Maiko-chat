/** Surface samples exported from the supplied FBX, in Y-up model space. */
export function decodeMaikoAtoms(buffer: ArrayBuffer, limit = 6800) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== 0x54414b4d || view.getUint32(4, true) !== 1) {
    throw new Error("Invalid Maiko point cloud");
  }
  const total = view.getUint32(8, true);
  if (!total || total > 20000 || buffer.byteLength !== 12 + total * 12) {
    throw new Error("Incomplete Maiko point cloud");
  }
  const count = Math.min(total, limit);
  const anchors = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const offset = 12 + Math.floor(i * total / count) * 12;
    for (let axis = 0; axis < 3; axis++) {
      anchors[i * 3 + axis] = view.getInt16(offset + axis * 2, true) / 8192;
      normals[i * 3 + axis] = view.getInt16(offset + 6 + axis * 2, true) / 32767;
    }
  }
  return { anchors, normals };
}

const HASH_SIZE = 16384;
const hash = (x: number, y: number, z: number) =>
  ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & (HASH_SIZE - 1);

export class MaikoAtoms {
  readonly positions: Float32Array;
  readonly velocity: Float32Array;
  private readonly heads = new Int32Array(HASH_SIZE);
  private readonly next: Int32Array;
  private readonly cells: Int32Array;

  constructor(readonly anchors: Float32Array, readonly normals: Float32Array, private readonly distance = 0.046) {
    this.positions = anchors.slice();
    this.velocity = new Float32Array(anchors.length);
    this.next = new Int32Array(anchors.length / 3);
    this.cells = new Int32Array(anchors.length);
  }

  /** Spatial hashing keeps repulsion local instead of checking every atom pair. */
  step(dt: number, time: number, pointer: { x: number; y: number } | null, rotation: number) {
    dt = Math.min(dt, 1 / 30);
    const p = this.positions, a = this.anchors, v = this.velocity;
    const DISTANCE = this.distance;
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    this.heads.fill(-1);
    for (let i = 0; i < this.next.length; i++) {
      const k = i * 3;
      const x = this.cells[k] = Math.floor(p[k] / DISTANCE);
      const y = this.cells[k + 1] = Math.floor(p[k + 1] / DISTANCE);
      const z = this.cells[k + 2] = Math.floor(p[k + 2] / DISTANCE);
      const bucket = hash(x, y, z);
      this.next[i] = this.heads[bucket];
      this.heads[bucket] = i;
    }
    const drag = Math.exp(-6 * dt);
    for (let i = 0; i < this.next.length; i++) {
      const k = i * 3;
      let fx = (a[k] - p[k]) * 26;
      let fy = (a[k + 1] - p[k + 1]) * 26;
      let fz = (a[k + 2] - p[k + 2]) * 26;
      const cx = this.cells[k], cy = this.cells[k + 1], cz = this.cells[k + 2];
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (let z = cz - 1; z <= cz + 1; z++) {
            for (let j = this.heads[hash(x, y, z)]; j !== -1; j = this.next[j]) {
              const q = j * 3;
              if (j === i || this.cells[q] !== x || this.cells[q + 1] !== y || this.cells[q + 2] !== z) continue;
              const dx = p[k] - p[q], dy = p[k + 1] - p[q + 1], dz = p[k + 2] - p[q + 2];
              const squared = dx * dx + dy * dy + dz * dz;
              if (squared >= DISTANCE * DISTANCE) continue;
              if (squared < 1e-10) { fx += i < j ? -0.3 : 0.3; continue; }
              const distance = Math.sqrt(squared);
              const force = (DISTANCE - distance) * 17 / distance;
              fx += dx * force; fy += dy * force; fz += dz * force;
            }
          }
        }
      }
      const phase = i * 2.399963;
      fx += Math.sin(time * 1.8 + phase) * 0.095;
      fy += Math.cos(time * 1.4 + phase) * 0.095;
      fz += Math.sin(time * 1.6 + phase) * 0.095;
      if (pointer) {
        const dx = p[k] * cos - p[k + 2] * sin - pointer.x;
        const dy = p[k + 1] - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 0.4 && distance > 0.0001) {
          const force = (1 - distance / 0.4) ** 2 * 11 / distance;
          fx += dx * force * cos;
          fy += dy * force;
          fz -= dx * force * sin;
        }
      }
      v[k] = (v[k] + fx * dt) * drag;
      v[k + 1] = (v[k + 1] + fy * dt) * drag;
      v[k + 2] = (v[k + 2] + fz * dt) * drag;
    }
    for (let k = 0; k < p.length; k++) p[k] += v[k] * dt;
  }
}

export const MOLECULE_RADIUS = 0.025;
export const PARTICLES_PER_MOLECULE = 4;
const INNER_LIMIT = MOLECULE_RADIUS - 0.004;
const CONTACT = 0.021;

/** Each surface sphere contains four independent particles, sharing one collision field. */
export class MaikoMolecules extends MaikoAtoms {
  readonly innerPositions: Float32Array;
  readonly innerVelocity: Float32Array;
  private readonly offsets: Float32Array;
  private readonly forces: Float32Array;
  private readonly innerHeads = new Int32Array(HASH_SIZE);
  private readonly innerNext: Int32Array;
  private readonly innerCells: Int32Array;

  constructor(anchors: Float32Array, normals: Float32Array) {
    super(anchors, normals, MOLECULE_RADIUS * 2);
    const length = anchors.length * PARTICLES_PER_MOLECULE;
    this.offsets = new Float32Array(length);
    this.innerPositions = new Float32Array(length);
    this.innerVelocity = new Float32Array(length);
    this.forces = new Float32Array(length);
    this.innerNext = new Int32Array(length / 3);
    this.innerCells = new Int32Array(length);
    for (let i = 0; i < length / 3; i++) {
      const k = i * 3, parent = Math.floor(i / PARTICLES_PER_MOLECULE) * 3;
      const angle = i * 2.399963;
      const y = ((i % PARTICLES_PER_MOLECULE) / 3 - 0.5) * 1.4;
      this.offsets[k] = Math.cos(angle) * Math.sqrt(1 - y * y) * INNER_LIMIT * 0.75;
      this.offsets[k + 1] = y * INNER_LIMIT * 0.75;
      this.offsets[k + 2] = Math.sin(angle) * Math.sqrt(1 - y * y) * INNER_LIMIT * 0.75;
      for (let axis = 0; axis < 3; axis++) this.innerPositions[k + axis] = anchors[parent + axis] + this.offsets[k + axis];
    }
  }

  override step(dt: number, time: number, pointer: { x: number; y: number } | null, rotation: number) {
    dt = Math.min(dt, 1 / 30);
    super.step(dt, time, pointer, rotation);
    const p = this.innerPositions, offsets = this.offsets, forces = this.forces, v = this.innerVelocity;
    this.innerHeads.fill(-1);
    forces.fill(0);
    for (let i = 0; i < this.innerNext.length; i++) {
      const k = i * 3, parent = Math.floor(i / PARTICLES_PER_MOLECULE) * 3;
      for (let axis = 0; axis < 3; axis++) p[k + axis] = this.positions[parent + axis] + offsets[k + axis];
      const x = this.innerCells[k] = Math.floor(p[k] / CONTACT);
      const y = this.innerCells[k + 1] = Math.floor(p[k + 1] / CONTACT);
      const z = this.innerCells[k + 2] = Math.floor(p[k + 2] / CONTACT);
      const bucket = hash(x, y, z);
      this.innerNext[i] = this.innerHeads[bucket];
      this.innerHeads[bucket] = i;
    }
    // No parent filter: particles across neighbouring sphere boundaries also repel.
    for (let i = 0; i < this.innerNext.length; i++) {
      const k = i * 3, cx = this.innerCells[k], cy = this.innerCells[k + 1], cz = this.innerCells[k + 2];
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (let z = cz - 1; z <= cz + 1; z++) {
            for (let j = this.innerHeads[hash(x, y, z)]; j !== -1; j = this.innerNext[j]) {
              const q = j * 3;
              if (j <= i || this.innerCells[q] !== x || this.innerCells[q + 1] !== y || this.innerCells[q + 2] !== z) continue;
              const dx = p[k] - p[q], dy = p[k + 1] - p[q + 1], dz = p[k + 2] - p[q + 2];
              const distance = Math.hypot(dx, dy, dz);
              if (distance >= CONTACT) continue;
              const strength = (CONTACT - distance) * 48 / Math.max(distance, 0.00001);
              const fx = distance < 0.00001 ? -0.4 : dx * strength;
              const fy = dy * strength, fz = dz * strength;
              forces[k] += fx; forces[k + 1] += fy; forces[k + 2] += fz;
              forces[q] -= fx; forces[q + 1] -= fy; forces[q + 2] -= fz;
            }
          }
        }
      }
    }
    const drag = Math.exp(-2.2 * dt);
    for (let i = 0; i < this.innerNext.length; i++) {
      const k = i * 3, parent = Math.floor(i / PARTICLES_PER_MOLECULE) * 3;
      for (let axis = 0; axis < 3; axis++) {
        const thermal = Math.sin(time * (2.6 + axis * 0.7) + i * 2.399963 + axis * 2.1) * 0.16;
        v[k + axis] = (v[k + axis] + (forces[k + axis] + thermal - offsets[k + axis] * 2) * dt) * drag;
        offsets[k + axis] += v[k + axis] * dt;
      }
      const radius = Math.hypot(offsets[k], offsets[k + 1], offsets[k + 2]);
      if (radius > INNER_LIMIT) {
        const nx = offsets[k] / radius, ny = offsets[k + 1] / radius, nz = offsets[k + 2] / radius;
        const outward = Math.max(0, v[k] * nx + v[k + 1] * ny + v[k + 2] * nz);
        offsets[k] = nx * INNER_LIMIT; offsets[k + 1] = ny * INNER_LIMIT; offsets[k + 2] = nz * INNER_LIMIT;
        v[k] -= nx * outward * 1.65; v[k + 1] -= ny * outward * 1.65; v[k + 2] -= nz * outward * 1.65;
      }
      for (let axis = 0; axis < 3; axis++) p[k + axis] = this.positions[parent + axis] + offsets[k + axis];
    }
  }
}
