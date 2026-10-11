"use client";

const ASSET_ROOT = "/audio/dtln-0.1.1";

export type DtlnGraph = {
  outputTrack: MediaStreamTrack;
  setEnabled(enabled: boolean): Promise<boolean>;
  stop(): Promise<void>;
};

/** AudioWorklet maintains a fixed playback timeline; a Worker runs the two models. */
export async function createDtlnGraph(
  sourceTrack: MediaStreamTrack,
  onFailure: () => void,
): Promise<DtlnGraph> {
  const ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
  let worker: Worker | undefined;
  let loading: Promise<void> | undefined;
  let stopped = false;
  let failed = false;
  let cancelReady: (() => void) | undefined;
  try {
    if (!ctx.audioWorklet || ctx.sampleRate !== 16000) {
      throw new Error("DTLN requires a 16 kHz AudioWorklet context");
    }
    await ctx.resume();
    await ctx.audioWorklet.addModule(`${ASSET_ROOT}/output.js`);
    const node = new AudioWorkletNode(ctx, "pulse-dtln-output", {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
      channelCountMode: "explicit", outputChannelCount: [1],
    });
    const source = ctx.createMediaStreamSource(new MediaStream([sourceTrack]));
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    destination.stream.getAudioTracks()[0].enabled = sourceTrack.enabled;
    source.connect(node).connect(destination);

    function fail() {
      if (stopped || failed) return;
      failed = true;
      node.port.postMessage({ type: "enabled", enabled: false });
      worker?.terminate();
      onFailure();
    }
    node.port.onmessage = ({ data }) => { if (data.type === "error") fail(); };
    node.onprocessorerror = () => {
      // Even a failed output worklet must not leave the microphone silent.
      node.disconnect();
      source.connect(destination);
      fail();
    };

    async function initialize() {
      const channel = new MessageChannel();
      worker = new Worker(`${ASSET_ROOT}/worker.js`, { type: "module", name: "DTLN" });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("DTLN initialization timed out")), 20000);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          cancelReady = undefined;
          if (worker) {
            worker.onmessage = ({ data }) => { if (data.type === "error") fail(); };
            worker.onerror = fail;
          }
          if (error) reject(error);
          else resolve();
        };
        cancelReady = () => finish(new Error("DTLN stopped"));
        worker!.onmessage = ({ data }) => {
          if (data.type === "ready") finish();
          if (data.type === "error") finish(new Error(data.message));
        };
        worker!.onerror = () => finish(new Error("DTLN worker failed"));
      });
      node.port.postMessage({ type: "worker", port: channel.port1 }, [channel.port1]);
      worker.postMessage({
        type: "init", port: channel.port2,
        assetRoot: new URL(ASSET_ROOT, window.location.href).href,
      }, [channel.port2]);
      await ready;
    }

    return {
      outputTrack: destination.stream.getAudioTracks()[0],
      async setEnabled(enabled) {
        if (stopped) return false;
        if (enabled && !failed) {
          try { await (loading ??= initialize()); }
          catch { fail(); }
        }
        if (stopped) return false;
        node.port.postMessage({ type: "enabled", enabled: enabled && !failed });
        return !failed;
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        cancelReady?.();
        worker?.terminate();
        node.port.postMessage({ type: "stop" });
        node.port.onmessage = null;
        node.onprocessorerror = null;
        source.disconnect();
        node.disconnect();
        node.port.close();
        destination.stream.getTracks().forEach((track) => track.stop());
        await ctx.close();
      },
    };
  } catch (error) {
    worker?.terminate();
    await ctx.close().catch(() => undefined);
    throw error;
  }
}
