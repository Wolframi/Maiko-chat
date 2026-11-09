type LiveKitModule = typeof import("livekit-client");
let loaded: LiveKitModule | undefined;
let pending: Promise<LiveKitModule> | undefined;

/** Share in-flight loads; a failed download can be retried on the next join. */
export function loadLiveKit(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const loading = pending ??= import("livekit-client").then(module => {
    loaded = module;
    return module;
  }).catch(error => { pending = undefined; throw error; });
  if (!signal) return loading;
  return new Promise<LiveKitModule>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void loading.then(module => { signal.removeEventListener("abort", abort); resolve(module); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

/** Media callbacks only run after startMedia has loaded the SDK. */
export function getLiveKit() {
  if (!loaded) throw new Error("Голосовой модуль ещё не загружен");
  return loaded;
}
