import type { MaikoParticleGraph } from "./maikoParticleMotion";

const HEADER_BYTES = 24;
const MAGIC = 0x47504b4d; // MKPG, little endian
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

/** Detect stale models and accidental corruption, including on insecure LAN origins. */
export function particleChecksum(buffer: ArrayBuffer) {
  let crc = 0xffffffff;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeMaikoParticleGraph(graph: MaikoParticleGraph) {
  const buffer = new ArrayBuffer(HEADER_BYTES + graph.neighbours.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, graph.neighbours.length / 3, true);
  view.setFloat64(16, graph.contact, true);
  graph.neighbours.forEach((value, i) => view.setInt32(HEADER_BYTES + i * 4, value, true));
  return buffer;
}

export function decodeMaikoParticleGraph(buffer: ArrayBuffer, count: number): MaikoParticleGraph {
  if (!Number.isInteger(count) || count < 1 || count > 100000 || buffer.byteLength !== HEADER_BYTES + count * 12) {
    throw new Error("Invalid particle graph size");
  }
  const view = new DataView(buffer);
  const contact = Math.min(0.022, Math.max(0.007, 0.007 * Math.sqrt(84000 / count)));
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 1 ||
      view.getUint32(8, true) !== count || view.getUint32(12, true) !== 0 || view.getFloat64(16, true) !== contact) {
    throw new Error("Invalid particle graph header");
  }
  const neighbours = new Int32Array(count * 3);
  for (let i = 0; i < neighbours.length; i++) {
    const value = view.getInt32(HEADER_BYTES + i * 4, true);
    if (value < -1 || value >= count || value === Math.floor(i / 3)) throw new Error("Invalid particle neighbour");
    neighbours[i] = value;
  }
  return { neighbours, contact };
}
