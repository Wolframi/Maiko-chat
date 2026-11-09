import { MAIKO_PARTICLE_GRAPH_ASSETS } from "./maikoParticleGraphAssets";
import { decodeMaikoParticleGraph, particleChecksum } from "./maikoParticleGraphBinary";
import type { MaikoIntro } from "./maikoIntro";
import type { MaikoParticleGraph } from "./maikoParticleMotion";

type Asset = { asset: string; checksum: number };
type Model = { bytes: number; checksum: number; graphs: Record<number, Asset> };
const models: Record<string, Model> = MAIKO_PARTICLE_GRAPH_ASSETS;
export type MaikoParticleGraphSource = (intro: MaikoIntro, count: number) => Promise<Uint8Array>;
const cache = new Map<string, Promise<MaikoParticleGraph | null>>();
const identities = new WeakMap<ArrayBuffer, Model | null>();
const LOAD_BUDGET_MS = 150;
const FETCH_TIMEOUT_MS = 4500;

export function maikoParticleGraphAsset(intro: MaikoIntro, count: number) {
  const asset = models[intro]?.graphs[count];
  return asset ? `${asset.asset}.gz` : undefined;
}

/** Start alongside model I/O. Cache validated data, including concurrent loads. */
export function warmMaikoParticleGraph(intro: MaikoIntro, count: number, source?: MaikoParticleGraphSource) {
  const asset = models[intro]?.graphs[count];
  if (!asset) return Promise.resolve(null);
  const previous = cache.get(asset.asset);
  if (previous) return previous;
  if (!source && (typeof window === "undefined" || !/^https?:$/.test(window.location.protocol))) return Promise.resolve(null);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<null>(resolve => {
    timeout = setTimeout(() => { controller.abort(); resolve(null); }, FETCH_TIMEOUT_MS);
  });
  const load = (async () => {
    let buffer: ArrayBuffer;
    if (source) buffer = new Uint8Array(await source(intro, count)).buffer;
    else {
      const response = await fetch(`${asset.asset}.gz`, { cache: "force-cache", signal: controller.signal });
      if (!response.ok) throw new Error("Particle data unavailable");
      buffer = await response.arrayBuffer();
    }
    if (particleChecksum(buffer) !== asset.checksum) throw new Error("Particle data checksum mismatch");
    return decodeMaikoParticleGraph(buffer, count);
  })().catch(() => null);
  const pending = Promise.race([load, expired]).finally(() => clearTimeout(timeout));
  cache.set(asset.asset, pending);
  return pending;
}

/** A cancelled consumer never aborts a load shared by other renderers. */
export async function loadMaikoParticleGraph(buffer: ArrayBuffer, count: number, signal?: AbortSignal, source?: MaikoParticleGraphSource) {
  signal?.throwIfAborted();
  let model = identities.get(buffer);
  if (model === undefined) {
    const candidates = Object.entries(models).filter(([, value]) => value.bytes === buffer.byteLength);
    const checksum = candidates.length ? particleChecksum(buffer) : undefined;
    model = candidates.find(([, value]) => value.checksum === checksum)?.[1] ?? null;
    identities.set(buffer, model);
  }
  if (!model?.graphs[count]) return null;
  const intro = Object.keys(models).find(key => models[key] === model) as MaikoIntro;
  const pending = warmMaikoParticleGraph(intro, count, source);
  const graph = await new Promise<MaikoParticleGraph | null>((resolve, reject) => {
    const finish = (value: MaikoParticleGraph | null) => {
      clearTimeout(timeout); signal?.removeEventListener("abort", abort); resolve(value);
    };
    const abort = () => {
      clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(signal?.reason);
    };
    const timeout = setTimeout(() => finish(null), LOAD_BUDGET_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    void pending.then(finish);
  });
  signal?.throwIfAborted();
  if (!graph) return null;
  performance.mark("maiko-graph-precomputed");
  // Renderers own their arrays; mutation must never poison the shared cache.
  return { neighbours: graph.neighbours.slice(), contact: graph.contact };
}
