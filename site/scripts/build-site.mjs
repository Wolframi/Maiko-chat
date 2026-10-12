import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// One ID for every build worker, the browser bundle and .next/BUILD_ID.
const version = randomUUID();
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, NEXT_PUBLIC_SITE_VERSION: version },
});
child.on("error", (error) => { console.error(error); process.exit(1); });
child.on("exit", (code) => process.exit(code ?? 1));
