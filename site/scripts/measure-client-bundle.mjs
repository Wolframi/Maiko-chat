import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const label = process.argv[2] || "current";
if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid measurement label");
const output = new URL("../../output/interface-loading/", import.meta.url);
await mkdir(output, { recursive: true });
const result = await build({
  entryPoints: ["src/components/chat/ChatApp.tsx", "src/components/chat/DesktopMediaHost.tsx"],
  outdir: fileURLToPath(new URL("chunks/", output)),
  bundle: true, splitting: true, format: "esm", platform: "browser", target: "chrome150",
  minify: true, write: false, metafile: true, jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const contents = new Map(result.outputFiles.map(file => [path.resolve(file.path), file.contents]));
const entries = [];
for (const [name, meta] of Object.entries(result.metafile.outputs)) {
  if (!meta.entryPoint || !/ChatApp\.tsx$|DesktopMediaHost\.tsx$/.test(meta.entryPoint)) continue;
  const initial = new Set();
  const visit = key => {
    if (initial.has(key)) return;
    initial.add(key);
    for (const item of result.metafile.outputs[key].imports) {
      if (!item.external && item.kind !== "dynamic-import") visit(item.path);
    }
  };
  visit(name);
  const modules = [...new Set([...initial].flatMap(key => Object.keys(result.metafile.outputs[key].inputs)))];
  entries.push({ entry: meta.entryPoint, initialChunks: initial.size,
    initialBytes: [...initial].reduce((sum, key) => sum + result.metafile.outputs[key].bytes, 0),
    initialGzipBytes: [...initial].reduce((sum, key) => sum + gzipSync(contents.get(path.resolve(key))).length, 0),
    liveKitInitiallyIncluded: modules.some(name => name.includes("node_modules/livekit-client/")),
    initialModules: modules,
  });
}
const report = { label, node: process.version, entries,
  note: "Isolated minified browser bundles with esbuild. Static import closure, excluding dynamic imports. Not the protected Next.js build or actual network/startup timings." };
await writeFile(new URL(`${label}-bundle.json`, output), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ label, entries: entries.map(entry => ({
  entry: entry.entry, initialChunks: entry.initialChunks, initialBytes: entry.initialBytes,
  initialGzipBytes: entry.initialGzipBytes, liveKitInitiallyIncluded: entry.liveKitInitiallyIncluded,
})) }, null, 2));
