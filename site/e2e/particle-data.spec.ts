import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { MAIKO_PARTICLE_GRAPH_ASSETS } from "../src/lib/maikoParticleGraphAssets";

type Harness = typeof import("../src/lib/maikoParticleGraph") & typeof import("../src/lib/maikoDance");
declare global { interface Window { particleDataHarness: Harness } }
let bundle: string;
let origin: string;
let server: ReturnType<typeof createServer>;
const requests: string[] = [];
test.beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `export * from "./src/lib/maikoParticleGraph";
    export { prepareMaikoDance, decodeMaikoDance } from "./src/lib/maikoDance";`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "iife", globalName: "particleDataHarness" })).outputFiles[0].text;
  server = createServer((req, res) => {
    if (req.url === "/") { res.end("<!doctype html><title>Particle data</title>"); return; }
    requests.push(req.url!);
    if (!/^\/(particles|models)\/maiko-[\w.-]+$/.test(req.url!)) { res.writeHead(404).end(); return; }
    void readFile(`public${req.url}`).then(bytes => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable",
        ...(req.url!.endsWith(".gz") ? { "Content-Encoding": "gzip" } : {}) });
      res.end(bytes);
    }).catch(() => res.writeHead(404).end());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
async function open(page: Page) { await page.goto(origin); await page.addScriptTag({ content: bundle }); }

test("full model loads precomputed data, shares concurrent work and reuses memory and HTTP caches", async ({ page }) => {
  requests.length = 0;
  for (let visit = 0; visit < 2; visit++) {
    await open(page);
    const result = await page.evaluate(async () => {
      const api = window.particleDataHarness;
      const buffer = await (await fetch("/models/maiko-hiphop.bin")).arrayBuffer();
      const start = performance.now();
      const first = api.warmMaikoParticleGraph("hiphop", 84000);
      const shared = first === api.warmMaikoParticleGraph("hiphop", 84000);
      await first;
      const loadMs = performance.now() - start;
      const [a, b] = await Promise.all([api.prepareMaikoDance(buffer, 84000), api.prepareMaikoDance(buffer, 84000)]);
      const neighbour = b.graph.neighbours[0]; a.graph.neighbours.fill(-1);
      const c = await api.prepareMaikoDance(buffer, 84000);
      const resource = performance.getEntriesByType("resource").find(entry => entry.name.includes("/particles/")) as PerformanceResourceTiming;
      return { shared, independent: b.graph.neighbours[0] === neighbour && c.graph.neighbours[0] === neighbour,
        precomputed: performance.getEntriesByName("maiko-graph-precomputed").length,
        rust: performance.getEntriesByName("maiko-graph-rust").length, js: performance.getEntriesByName("maiko-graph-js").length,
        loadMs, encoded: resource.encodedBodySize, decoded: resource.decodedBodySize, transfer: resource.transferSize };
    });
    expect(result).toMatchObject({ shared: true, independent: true, precomputed: 3, rust: 0, js: 0 });
    expect(result.decoded).toBe(1008024);
    if (visit === 1) expect(result.transfer).toBe(0);
    console.log(`precomputed visit ${visit}: ${JSON.stringify(result)}`);
  }
  expect(requests.filter(path => path.startsWith("/particles/"))).toHaveLength(1);
  expect(requests.some(path => path.includes("wasm"))).toBe(false);
});

test("cancelled consumer leaves the shared native source usable", async ({ page }) => {
  await open(page);
  const graphAsset = MAIKO_PARTICLE_GRAPH_ASSETS.samba.graphs[7000].asset;
  const result = await page.evaluate(async graphAsset => {
    const api = window.particleDataHarness, buffer = await (await fetch("/models/maiko-samba.bin")).arrayBuffer();
    const graph = new Uint8Array(await (await fetch(graphAsset)).arrayBuffer());
    let release!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const source = async () => { calls++; await gate; return graph; };
    const controller = new AbortController();
    const pending = api.loadMaikoParticleGraph(buffer, 7000, controller.signal, source);
    controller.abort();
    let name = ""; try { await pending; } catch (error) { name = (error as Error).name; }
    release();
    const loaded = await api.loadMaikoParticleGraph(buffer, 7000, undefined, source);
    return { name, calls, count: loaded?.neighbours.length };
  }, graphAsset);
  expect(result).toEqual({ name: "AbortError", calls: 1, count: 21000 });
});

for (const mode of ["missing", "corrupt", "stalled"] as const) test(`${mode} binary falls back to the original graph within the loading budget`, async ({ page }) => {
  let calls = 0;
  await page.route("**/particles/**", route => {
    calls++;
    if (mode === "stalled") return;
    return route.fulfill({ status: mode === "missing" ? 404 : 200, body: "corrupt" });
  });
  await open(page);
  const result = await page.evaluate(async () => {
    const api = window.particleDataHarness, buffer = await (await fetch("/models/maiko-samba.bin")).arrayBuffer();
    const start = performance.now();
    const prepared = await api.prepareMaikoDance(buffer, 7000);
    return { elapsed: performance.now() - start, count: prepared.graph.neighbours.length,
      precomputed: performance.getEntriesByName("maiko-graph-precomputed").length,
      computed: performance.getEntriesByName("maiko-graph-js").length + performance.getEntriesByName("maiko-graph-rust").length };
  });
  expect(result).toMatchObject({ count: 21000, precomputed: 0, computed: 1 });
  expect(result.elapsed).toBeLessThan(1500);
  expect(calls).toBe(1);
});

test("changed model and custom density cannot receive a stale precomputed graph", async ({ page }) => {
  await open(page);
  expect(await page.evaluate(async () => {
    const api = window.particleDataHarness, buffer = await (await fetch("/models/maiko-hiphop.bin")).arrayBuffer();
    let calls = 0;
    const source = async () => { calls++; return new Uint8Array(); };
    const custom = await api.loadMaikoParticleGraph(buffer, 1234, undefined, source);
    const changed = buffer.slice(0); new Uint8Array(changed)[100] ^= 1;
    const stale = await api.loadMaikoParticleGraph(changed, 84000, undefined, source);
    return { custom, stale, calls };
  })).toEqual({ custom: null, stale: null, calls: 0 });
});
