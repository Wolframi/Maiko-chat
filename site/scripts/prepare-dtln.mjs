import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Keep audio executables outside Next's module runtime; models/WASM stay unchanged.
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("@workadventure/noise-suppression/package.json"));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (version !== "0.1.1") throw new Error("Update DTLN asset URLs and audio tests before upgrading the runtime.");
const target = new URL(`../public/audio/dtln-${version}/`, import.meta.url);
await mkdir(target, { recursive: true });
for (const [source, name] of [
  ["dist/vendor/litert/litert_wasm_compat_internal.wasm", "runtime.wasm"],
  ["dist/assets/model_quant_1.tflite", "model-1.tflite"],
  ["dist/assets/model_quant_2.tflite", "model-2.tflite"],
  ["LICENSE", "LICENSE"],
]) {
  await copyFile(path.join(root, source), new URL(name, target));
}
await build({
  entryPoints: [fileURLToPath(new URL("../src/audio/dtln.worker.js", import.meta.url))],
  outfile: fileURLToPath(new URL("worker.js", target)),
  bundle: true, format: "esm", platform: "browser", minify: true,
  // Emscripten's Node-only branches are unreachable in a browser Worker.
  external: ["node:*"],
  alias: { "dtln-litert-factory": path.join(root, "dist/vendor/litert/litert_wasm_compat_internal.mjs") },
});
await copyFile(new URL("../src/audio/dtln.worklet.js", import.meta.url), new URL("output.js", target));
for (const name of ["DTLN-LICENSE.txt", "LiteRT-LICENSE.txt"]) {
  await copyFile(new URL(`../../docs/licenses/${name}`, import.meta.url), new URL(name, target));
}
await writeFile(new URL("NOTICE.txt", target),
  `DTLN models: Nils L. Westhausen, https://github.com/breizhn/DTLN (MIT).\n` +
  `Browser implementation: @workadventure/noise-suppression ${version} (MIT).\n` +
  `LiteRT: Google, https://github.com/google-ai-edge/LiteRT (Apache-2.0).\n`);
console.log(`Prepared local DTLN ${version} worklet and WASM assets.`);
