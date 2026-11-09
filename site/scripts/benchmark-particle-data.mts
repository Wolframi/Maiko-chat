import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { MAIKO_PARTICLE_GRAPH_ASSETS } from "../src/lib/maikoParticleGraphAssets";

const site = new URL("../", import.meta.url);
const bundle = (await build({ stdin: { contents: `export * from "./src/lib/maikoParticleGraph";
  export { decodeMaikoDance } from "./src/lib/maikoDance";
  export { warmMaikoParticleWasm } from "./src/lib/maikoParticleWasm";`,
  resolveDir: fileURLToPath(site), loader: "ts" },
  bundle: true, write: false, format: "iife", globalName: "particleDataBenchmark" })).outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === "/") { res.end('<!doctype html><title>Particle graph benchmark</title>'); return; }
  if (!/^\/(particles|models|wasm)\/[\w.-]+$/.test(req.url!)) { res.writeHead(404).end(); return; }
  void readFile(new URL(`public${req.url}`, site)).then(bytes => {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable",
      ...(req.url!.endsWith(".gz") ? { "Content-Encoding": "gzip" } : {}) }); res.end(bytes);
  }).catch(() => res.writeHead(404).end());
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
const rows = [];
try {
  for (const intro of ["hiphop", "samba"] as const) {
    const samples = [];
    for (let sample = 0; sample < 7; sample++) {
      // New context: no memory or HTTP cache. Navigation below retains HTTP cache only.
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin); await page.addScriptTag({ content: bundle });
      const run = async () => page.evaluate(async intro => {
        const api = (window as unknown as { particleDataBenchmark: typeof import("../src/lib/maikoParticleGraph") &
          typeof import("../src/lib/maikoDance") & typeof import("../src/lib/maikoParticleWasm") }).particleDataBenchmark;
        const buffer = await (await fetch(`/models/maiko-${intro}.bin`)).arrayBuffer();
        const start = performance.now();
        await api.warmMaikoParticleGraph(intro, 84000);
        const graph = await api.loadMaikoParticleGraph(buffer, 84000);
        const loadMs = performance.now() - start;
        if (!graph) throw new Error("Missing precomputed graph");
        const hot = performance.now(); await api.loadMaikoParticleGraph(buffer, 84000);
        const memoryMs = performance.now() - hot;
        const resource = performance.getEntriesByType("resource").find(entry => entry.name.includes("/particles/")) as PerformanceResourceTiming;
        return { loadMs, memoryMs, transferBytes: resource.transferSize };
      }, intro);
      const cold = await run();
      await page.goto(origin); await page.addScriptTag({ content: bundle });
      const cached = await run();
      const rustMs = await page.evaluate(async intro => {
        const api = (window as unknown as { particleDataBenchmark: typeof import("../src/lib/maikoDance") & typeof import("../src/lib/maikoParticleWasm") }).particleDataBenchmark;
        const input = await (await fetch(`/models/maiko-${intro}.bin`)).arrayBuffer();
        const dance = api.decodeMaikoDance(input);
        const builder = await api.warmMaikoParticleWasm();
        if (!builder) throw new Error("Missing Rust benchmark baseline");
        const start = performance.now(); await builder.prepare(dance.data, dance.count);
        return performance.now() - start;
      }, intro);
      samples.push({ cold, cached, rustMs });
      await context.close();
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const row = { intro, count: 84000, gzipBytes: MAIKO_PARTICLE_GRAPH_ASSETS[intro].graphs[84000].gzipBytes,
      coldMs: median(samples.map(s => s.cold.loadMs)), httpCacheMs: median(samples.map(s => s.cached.loadMs)),
      memoryMs: median(samples.map(s => s.cached.memoryMs)), rustMs: median(samples.map(s => s.rustMs)), samples };
    rows.push(row); console.log(JSON.stringify(row));
  }
  const output = new URL("../../output/particle-data/", import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL("benchmark.json", output), JSON.stringify({ measuredAt: new Date().toISOString(),
    cpu: cpus()[0]?.model, browser: browser.version(), node: process.version,
    notes: "Seven samples. Local HTTP; cold context, HTTP cache after navigation, then memory cache. Includes graph fetch, gzip decoding, model/binary checksum, graph decode and owned copy. Model I/O/decoding, GPU and application startup excluded. Rust is the existing asynchronous builder with loaded WASM; no compilation or network.", rows }, null, 2) + "\n");
} finally {
  await browser.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
