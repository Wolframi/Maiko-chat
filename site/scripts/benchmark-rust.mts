import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import type { runParticleBenchmark } from "../experiments/particle-graph/browserBenchmark";

const site = new URL("../", import.meta.url);
const output = new URL("../../output/rust-audit/", import.meta.url);
await mkdir(output, { recursive: true });
execFileSync("cargo", ["build", "--manifest-path", fileURLToPath(new URL("native/particle-graph/Cargo.toml", site)),
  "--locked", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", fileURLToPath(new URL("target", output))],
{ stdio: "inherit", windowsHide: true });
const wasm = await readFile(new URL("target/wasm32-unknown-unknown/release/maiko_particle_graph.wasm", output));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("experiments/particle-graph/browserBenchmark.ts", site))],
  bundle: true, write: false, format: "iife", globalName: "particleBenchmark", platform: "browser", target: "es2020",
});
const assets = new Map<string, { type: string; body: Uint8Array | string }>([
  ["/", { type: "text/html", body: '<!doctype html><meta charset="utf-8"><title>Maiko Rust benchmark</title><p>Isolated particle graph benchmark. Results are saved by the runner.</p><script src="/bench.js"></script>' }],
  ["/bench.js", { type: "text/javascript", body: bundle.outputFiles[0].contents }],
  ["/graph.wasm", { type: "application/wasm", body: wasm }],
]);
for (const model of ["hiphop", "samba"]) assets.set(`/models/maiko-${model}.bin`, {
  type: "application/octet-stream", body: await readFile(new URL(`public/models/maiko-${model}.bin`, site)),
});
const server = createServer((req, res) => {
  const asset = assets.get(req.url ?? "");
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" }); res.end(asset.body);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No benchmark port");
let browser: Browser | undefined;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "log") console.log(message.text()); });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate<Awaited<ReturnType<typeof runParticleBenchmark>>>("particleBenchmark.runParticleBenchmark()");
  if (errors.length) throw new Error(errors.join("\n"));
  const report = { measuredAt: new Date().toISOString(), cpu: cpus()[0]?.model,
    platform: platform(), arch: arch(), node: process.version, browser: browser.version(),
    wasmGzipBytes: gzipSync(wasm).byteLength, ...result };
  await writeFile(new URL("browser.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${fileURLToPath(new URL("browser.json", output))}`);
} finally {
  try { await browser?.close(); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
