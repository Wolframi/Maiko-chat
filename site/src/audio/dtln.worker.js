import { createNoiseSuppressionRuntime } from "@workadventure/noise-suppression";
import createLiteRt from "dtln-litert-factory";

// Inference never runs on the audio rendering thread or the UI thread.
self.onmessage = async ({ data }) => {
  if (data.type !== "init") return;
  const port = data.port;
  try {
    const read = async (name) => {
      const response = await fetch(`${data.assetRoot}/${name}`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`DTLN ${name}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const [wasm, model1, model2] = await Promise.all([
      read("runtime.wasm"), read("model-1.tflite"), read("model-2.tflite"),
    ]);
    const runtime = await createNoiseSuppressionRuntime({
      liteRtWasmRoot: data.assetRoot, liteRtWasmModuleFactory: createLiteRt,
      liteRtWasmBinary: wasm, model1Data: model1, model2Data: model2,
      threads: false, numThreads: 1,
    });
    let handle = runtime.dtln_create();
    let previous = -1;
    const output = new Float32Array(128);
    port.onmessage = ({ data: frame }) => {
      try {
        if (previous >= 0 && frame.sequence !== previous + 1) {
          // Bypass/overload must not splice stale LSTM history into new audio.
          runtime.dtln_stop(handle);
          handle = runtime.dtln_create();
        }
        previous = frame.sequence;
        runtime.dtln_denoise(handle, frame.samples, output);
        port.postMessage({ sequence: frame.sequence, samples: output });
      } catch (error) {
        self.postMessage({ type: "error", message: String(error) });
        port.close();
      }
    };
    port.start();
    self.postMessage({ type: "ready" });
  } catch (error) {
    self.postMessage({ type: "error", message: String(error) });
    port.close();
  }
};
