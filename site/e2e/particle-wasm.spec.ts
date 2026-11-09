import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { MAIKO_PARTICLE_WASM_URL } from "../src/lib/maikoParticleWasmAsset";

type Harness = typeof import("../src/lib/maikoParticleWasm") & typeof import("../src/lib/maikoParticleMotion");
declare global { interface Window { particleHarness: Harness } }
let bundle: string;
const wasm = readFile(`public${MAIKO_PARTICLE_WASM_URL}`);
test.beforeAll(async () => {
  bundle = (await build({ stdin: { contents: `export * from "./src/lib/maikoParticleWasm";
    export { createMaikoParticleGraph } from "./src/lib/maikoParticleMotion";`,
    resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false,
    format: "iife", globalName: "particleHarness", target: "es2020" })).outputFiles[0].text;
});

async function open(page: Page, mode: "ok" | "missing" | "corrupt" | "stalled" | "slow" = "ok") {
  let requests = 0;
  await page.route("http://particle-wasm.test/**", async route => {
    if (new URL(route.request().url()).pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Particles</title>" });
    requests++;
    if (mode === "stalled") return; // AbortController must release the waiting caller.
    if (mode === "missing") return route.fulfill({ status: 404 });
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 250));
    return route.fulfill({ contentType: "application/wasm", body: mode === "corrupt" ? Buffer.from("invalid module") : await wasm });
  });
  await page.goto("http://particle-wasm.test/");
  await page.addScriptTag({ content: bundle });
  return () => requests;
}

test("browser loads one shared Rust module and returns the exact JS graph", async ({ page }) => {
  const requests = await open(page);
  const result = await page.evaluate(async () => {
    const api = window.particleHarness;
    const first = api.warmMaikoParticleWasm(), second = api.warmMaikoParticleWasm();
    const builder = await first;
    const data = new Float32Array(2048 * 16);
    for (let i = 0; i < 2048; i++) { data[i * 16] = (i % 20) / 8192; data[i * 16 + 1] = Math.floor(i / 20) / 8192; }
    const actual = await api.prepareMaikoParticleGraphAccelerated(data, 2048);
    const expected = api.createMaikoParticleGraph(data, 2048);
    return { loaded: !!builder, shared: first === second,
      equal: actual.contact === expected.contact && actual.neighbours.every((n, i) => n === expected.neighbours[i]) };
  });
  expect(result).toEqual({ loaded: true, shared: true, equal: true });
  expect(requests()).toBe(1);
});

test("a cold load exceeding the UI budget can still use Rust once the model arrives", async ({ page }) => {
  const requests = await open(page, "slow");
  const result = await page.evaluate(async () => {
    const api = window.particleHarness;
    const first = await api.warmMaikoParticleWasm();
    // Model IPC/download takes longer than the small WASM module on cold starts.
    await new Promise(resolve => setTimeout(resolve, 300));
    const graph = await api.prepareMaikoParticleGraphAccelerated(new Float32Array(16), 1);
    return { first: first === null, recovered: !!(await api.warmMaikoParticleWasm()),
      rust: performance.getEntriesByName("maiko-graph-rust").length,
      js: performance.getEntriesByName("maiko-graph-js").length, neighbours: [...graph.neighbours] };
  });
  expect(result).toEqual({ first: true, recovered: true, rust: 1, js: 0, neighbours: [-1, -1, -1] });
  expect(requests()).toBe(1);
});

for (const mode of ["missing", "corrupt", "stalled"] as const) test(`${mode} WASM falls back once without blocking the intro`, async ({ page }) => {
  const requests = await open(page, mode);
  const result = await page.evaluate(async () => {
    const api = window.particleHarness, data = new Float32Array(32); data[16] = 0.001;
    const start = performance.now();
    const first = await api.prepareMaikoParticleGraphAccelerated(data, 2);
    const second = await api.prepareMaikoParticleGraphAccelerated(data, 2);
    const expected = api.createMaikoParticleGraph(data, 2);
    return { fallback: await api.warmMaikoParticleWasm() === null,
      equal: [first, second].every(graph => graph.contact === expected.contact && graph.neighbours.every((n, i) => n === expected.neighbours[i])),
      elapsed: performance.now() - start };
  });
  expect(result.fallback).toBe(true); expect(result.equal).toBe(true);
  expect(result.elapsed).toBeLessThan(1500);
  expect(requests()).toBe(1);
});

test("without WebAssembly the browser prepares the original JS graph without fetching", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "WebAssembly", { value: undefined }));
  const requests = await open(page);
  expect(await page.evaluate(async () => {
    const graph = await window.particleHarness.prepareMaikoParticleGraphAccelerated(new Float32Array(16), 1);
    return [...graph.neighbours];
  })).toEqual([-1, -1, -1]);
  expect(requests()).toBe(0);
});

test("unmounting while WASM loads promptly cancels that preparation", async ({ page }) => {
  await open(page, "stalled");
  expect(await page.evaluate(async () => {
    const controller = new AbortController();
    const pending = window.particleHarness.prepareMaikoParticleGraphAccelerated(new Float32Array(16), 1, controller.signal);
    controller.abort();
    try { await pending; return "resolved"; } catch (error) { return (error as DOMException).name; }
  })).toBe("AbortError");
});

test("one cancelled caller leaves the shared WASM load usable", async ({ page }) => {
  const requests = await open(page);
  const result = await page.evaluate(async () => {
    const api = window.particleHarness, controller = new AbortController();
    const loading = api.warmMaikoParticleWasm();
    const pending = api.prepareMaikoParticleGraphAccelerated(new Float32Array(16), 1, controller.signal);
    controller.abort();
    let errorName = "";
    try { await pending; } catch (error) { errorName = (error as DOMException).name; }
    return { errorName, loaded: !!(await loading), neighbours: [...(await api.prepareMaikoParticleGraphAccelerated(new Float32Array(16), 1)).neighbours] };
  });
  expect(result).toEqual({ errorName: "AbortError", loaded: true, neighbours: [-1, -1, -1] });
  expect(requests()).toBe(1);
});

test("a WASM execution trap discards the instance and retries using JS", async ({ page }) => {
  await page.addInitScript(`const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
    WebAssembly.instantiate = async (...args) => {
      const result = await originalInstantiate(...args);
      if (!result.instance) return result;
      return { module: result.module, instance: { exports: { ...result.instance.exports,
        graph_step() { throw new WebAssembly.RuntimeError("Simulated execution trap"); } } } };
    };`);
  const requests = await open(page);
  expect(await page.evaluate(async () => {
    const api = window.particleHarness;
    const loaded = !!(await api.warmMaikoParticleWasm());
    const graph = await api.prepareMaikoParticleGraphAccelerated(new Float32Array(16), 1);
    return { loaded, fallback: await api.warmMaikoParticleWasm() === null, neighbours: [...graph.neighbours] };
  })).toEqual({ loaded: true, fallback: true, neighbours: [-1, -1, -1] });
  expect(requests()).toBe(1);
});
