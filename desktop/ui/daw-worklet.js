/* Stereo float32 DAW capture -> Web Audio. Runs off the renderer's UI thread. */
class MaikoDawAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 65536;
    this.audio = new Float32Array(this.capacity * 2);
    this.read = 0; this.write = 0; this.rate = 48000; this.playing = false;
    this.port.onmessage = ({ data }) => {
      const rate = data.sampleRate, samples = data.samples;
      if (!Number.isFinite(rate) || rate < 8000 || rate > 384000 || !(samples instanceof Float32Array) || samples.length % 2) return;
      if (rate !== this.rate) { this.read = 0; this.write = 0; this.playing = false; this.rate = rate; }
      const frames = samples.length / 2;
      if (frames > this.capacity / 2) return;
      for (let i = 0; i < frames; i++) {
        const offset = ((this.write + i) % this.capacity) * 2;
        const left = samples[i * 2], right = samples[i * 2 + 1];
        this.audio[offset] = Number.isFinite(left) ? Math.max(-1, Math.min(1, left)) : 0;
        this.audio[offset + 1] = Number.isFinite(right) ? Math.max(-1, Math.min(1, right)) : 0;
      }
      this.write += frames;
      // Recover from IPC stalls without accumulating seconds of audio delay.
      if (this.write - this.read > Math.min(this.capacity / 2, rate * 0.12)) {
        this.read = this.write - Math.ceil(rate * 0.03);
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.[0]) return true;
    if (!this.playing && this.write - this.read >= this.rate * 0.02) this.playing = true;
    const ratio = this.rate / sampleRate;
    for (let i = 0; i < output[0].length; i++) {
      if (!this.playing || this.read + ratio + 1 >= this.write) {
        for (const channel of output) channel[i] = 0;
        this.playing = false; continue;
      }
      const frame = Math.floor(this.read), fraction = this.read - frame;
      const a = (frame % this.capacity) * 2, b = ((frame + 1) % this.capacity) * 2;
      for (let ch = 0; ch < output.length; ch++) {
        const channel = Math.min(ch, 1);
        output[ch][i] = this.audio[a + channel] * (1 - fraction) + this.audio[b + channel] * fraction;
      }
      this.read += ratio;
    }
    // Keep counters small over long sessions, preserving fractional position.
    if (this.read >= this.capacity * 4) {
      const offset = Math.floor(this.read / this.capacity) * this.capacity;
      this.read -= offset; this.write -= offset;
    }
    return true;
  }
}
registerProcessor('maiko-daw-audio', MaikoDawAudio);
