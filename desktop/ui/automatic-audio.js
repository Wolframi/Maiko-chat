// App-owned module, loaded at the trusted site's origin under its normal CSP.
export async function attachAutomaticAudio(stream, policy, describeIsolatedTrack) {
  const bridge = window.maikoScreenAudio;
  const nativeTracks = stream.getAudioTracks();
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const tracks = new Set(), sources = new Map();
  let unsubscribe, closed = false, health;
  const output = context.createMediaStreamDestination();
  const primary = context.createGain(); primary.connect(output);
  let nativeSource;
  const cleanup = () => {
    if (closed) return;
    closed = true; clearInterval(health); unsubscribe?.();
    for (const entry of sources.values()) { entry.node.disconnect(); entry.gain.disconnect(); }
    sources.clear(); nativeSource?.disconnect(); primary.disconnect();
    nativeTracks.forEach((track) => track.stop());
    for (const track of tracks) MediaStreamTrack.prototype.stop.call(track);
    tracks.clear();
    void context.close().catch(() => {});
    void bridge.stopDaw(policy.token).catch(() => {});
  };
  const ownTrack = (track) => {
    tracks.add(track);
    Object.defineProperty(track, 'stop', { value: () => {
      MediaStreamTrack.prototype.stop.call(track); tracks.delete(track);
      if (!tracks.size) cleanup();
    } });
  };
  const gain = (node, value) => {
    if (node.gain.value !== value) node.gain.setTargetAtTime(value, context.currentTime, 0.008);
  };
  const routing = () => {
    const now = performance.now();
    const active = [...sources.values()].some((entry) => now - entry.lastAudio < 800);
    gain(primary, policy.kind === 'application' && active ? 0 : 1);
    for (const entry of sources.values()) {
      // Shared-mode DAWs already arrive through Windows; ASIO DAWs do not.
      gain(entry.gain, policy.kind === 'system' && entry.nativeOutput ? 0 : 1);
    }
  };
  try {
    await context.audioWorklet.addModule('/__maiko_desktop/daw-worklet.js');
    if (nativeTracks.length) {
      nativeSource = context.createMediaStreamSource(new MediaStream(nativeTracks));
      nativeSource.connect(primary);
    }
    for (const track of nativeTracks) stream.removeTrack(track);
    for (const track of output.stream.getAudioTracks()) {
      track.contentHint = 'music'; describeIsolatedTrack(track, ownTrack); ownTrack(track); stream.addTrack(track);
    }
    const video = stream.getVideoTracks()[0];
    video?.addEventListener('ended', cleanup, { once: true });
    if (video) {
      const stop = video.stop.bind(video);
      Object.defineProperty(video, 'stop', { value: () => { cleanup(); stop(); } });
    }
    unsubscribe = bridge.onDawAudio((packet) => {
      if (closed || packet.token !== policy.token) return;
      if (packet.ended) {
        const ended = [...tracks]; cleanup();
        ended.forEach((track) => track.dispatchEvent(new Event('ended'))); return;
      }
      if (packet.removed) {
        const entry = sources.get(packet.id);
        if (entry) { entry.node.disconnect(); entry.gain.disconnect(); sources.delete(packet.id); }
        routing(); return;
      }
      let entry = sources.get(packet.id);
      if (!entry && packet.samples) {
        const node = new AudioWorkletNode(context, 'maiko-daw-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        const level = context.createGain(); node.connect(level).connect(output);
        entry = { node, gain: level, nativeOutput: packet.nativeOutput, lastAudio: -Infinity };
        sources.set(packet.id, entry);
      }
      if (entry) {
        entry.nativeOutput = packet.nativeOutput;
        if (packet.samples) {
          entry.lastAudio = performance.now();
          const bytes = new Uint8Array(packet.samples);
          entry.node.port.postMessage({ sampleRate: packet.sampleRate, samples: new Float32Array(bytes.buffer) });
        }
      }
      routing();
    });
    health = setInterval(routing, 200);
    await context.resume();
    await bridge.startDaw(policy.token);
    if (closed || video?.readyState === 'ended') throw new DOMException('Демонстрация остановлена', 'NotReadableError');
    Object.defineProperty(stream, 'maikoAudioSource', { value: 'automatic' });
  } catch (error) { cleanup(); throw error; }
}
