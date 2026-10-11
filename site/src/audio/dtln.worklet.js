/* global AudioWorkletProcessor, registerProcessor, sampleRate */
const QUANTUM = 128;
const JITTER_FRAMES = 8;
const MODEL_DELAY = 384;
const DRY_DELAY = JITTER_FRAMES * QUANTUM + MODEL_DELAY;
const CAPACITY = 64;

class DtlnOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    if (sampleRate !== 16000) throw new Error("DTLN requires 16 kHz");
    this.sequence = 0;
    this.enabled = false;
    this.workerPort = null;
    this.inFlight = 0;
    this.mix = 0;
    this.lastOutput = 0;
    this.lastDelta = 0;
    this.correction = 0;
    this.wasAvailable = false;
    this.hasWet = false;
    this.lastWet = 0;
    this.misses = 0;
    this.failed = false;
    this.stopped = false;
    this.dry = new Float32Array(DRY_DELAY);
    this.dryPosition = 0;
    this.silence = new Float32Array(QUANTUM);
    this.wet = new Float32Array(CAPACITY * QUANTUM);
    this.tags = new Float64Array(CAPACITY).fill(-1);
    this.port.onmessage = ({ data }) => {
      if (data.type === "worker") {
        this.workerPort = data.port;
        this.workerPort.onmessage = ({ data: frame }) => {
          this.inFlight = Math.max(0, this.inFlight - 1);
          if (frame.sequence < this.sequence - JITTER_FRAMES) return;
          const slot = frame.sequence % CAPACITY;
          this.wet.set(frame.samples, slot * QUANTUM);
          this.tags[slot] = frame.sequence;
        };
        this.workerPort.start();
      } else if (data.type === "enabled") {
        if (data.enabled !== this.enabled) this.hasWet = false;
        this.enabled = data.enabled;
      } else if (data.type === "stop") {
        this.stopped = true;
        this.workerPort?.close();
      }
    };
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0] ?? this.silence;
    if (output.length !== QUANTUM) {
      this.port.postMessage({ type: "error", message: "Unsupported audio render quantum" });
      return false;
    }
    const sequence = this.sequence++;
    if (this.workerPort && this.enabled && !this.failed && this.inFlight < JITTER_FRAMES) {
      this.workerPort.postMessage({ sequence, samples: input });
      this.inFlight++;
    }
    const playSequence = sequence - JITTER_FRAMES;
    const slot = ((playSequence % CAPACITY) + CAPACITY) % CAPACITY;
    const available = playSequence >= 0 && this.tags[slot] === playSequence;
    if (available) this.hasWet = true;
    const target = this.enabled && this.hasWet && !this.failed ? 1 : 0;
    const transition = available !== this.wasAvailable;
    this.wasAvailable = available;

    // A late inference must not reopen the raw mic for a keyboard click/thump.
    // Brief gaps fade the last denoised sample; sustained failure falls back to
    // browser NS through the existing error path. Bypass still uses aligned dry.
    for (let i = 0; i < output.length; i++) {
      const dry = this.dry[this.dryPosition];
      this.dry[this.dryPosition] = input[i] ?? 0;
      this.dryPosition = (this.dryPosition + 1) % DRY_DELAY;
      this.mix += Math.max(-1 / 400, Math.min(1 / 400, target - this.mix));
      const wet = available ? this.wet[slot * QUANTUM + i] : this.lastWet * 0.98;
      this.lastWet = wet;
      let value = dry + (wet - dry) * this.mix;
      if (!Number.isFinite(value)) {
        value = dry;
        this.failed = true;
        this.port.postMessage({ type: "error", message: "Non-finite DTLN output" });
      }
      // Suppress exceptional packet-boundary steps (model reset/clock correction),
      // while preserving ordinary waveform slopes, including sharp speech sounds.
      const boundaryStep = Math.abs(value - this.lastOutput);
      if (i === 0 && (transition || boundaryStep > Math.max(0.02, Math.abs(this.lastDelta) * 4))) {
        this.correction = this.lastOutput - value;
      }
      value += this.correction;
      this.correction *= 0.96;
      output[i] = Math.max(-1, Math.min(1, value));
      this.lastDelta = output[i] - this.lastOutput;
      this.lastOutput = output[i];
    }
    if (this.enabled && this.workerPort && !available) this.misses++;
    else this.misses = 0;
    if (this.misses > 125 && !this.failed) {
      this.failed = true;
      this.port.postMessage({ type: "error", message: "DTLN cannot keep up with realtime audio" });
    }
    return true;
  }
}

registerProcessor("pulse-dtln-output", DtlnOutput);
