"use strict";

/**
 * Isolated SuperFlux onset detector. WASM abort must not kill the chat server.
 * stdin: Float32 LE PCM, argv[2] = sampleRate
 * stdout: {"onsets":[seconds...]}
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const es = require("essentia.js");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

function toFloat32(value, essentia) {
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return Float32Array.from(value);
  return essentia.vectorToArray(value);
}

(async () => {
  const sampleRate = Math.max(8000, Number(process.argv[2]) || 22050);
  const buf = await readStdin();
  if (buf.byteLength < sampleRate) {
    process.stdout.write(JSON.stringify({ onsets: [] }));
    return;
  }
  const samples = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    Math.floor(buf.byteLength / 4),
  );
  const essentia = new es.Essentia(es.EssentiaWASM);
  const vector = essentia.arrayToVector(samples);
  try {
    const raw = essentia.SuperFluxExtractor(
      vector,
      40,
      2048,
      256,
      16,
      sampleRate,
      0.05,
    );
    const onsets = toFloat32(raw.onsets, essentia);
    process.stdout.write(
      JSON.stringify({
        onsets: Array.from(onsets).filter((t) => Number.isFinite(t) && t >= 0),
      }),
    );
  } finally {
    if (vector && typeof vector.delete === "function") vector.delete();
  }
})().catch((err) => {
  process.stderr.write(String((err && err.stack) || err));
  process.exit(1);
});
