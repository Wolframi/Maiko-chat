import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { verifyCodeProtection } from "./verify-code-protection.mjs";
import path from "node:path";

const require = createRequire(import.meta.url);
// One ID for every build worker, the browser bundle and .next/BUILD_ID.
const version = randomUUID();
const args = process.argv.slice(2);
if (args.some(arg => /^(?:--turbo|--turbopack)(?:=|$)/.test(arg))) {
  throw new Error("Protected production builds require Webpack. Use npm run build without --turbopack.");
}
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build", "--webpack", ...args.filter(arg => arg !== "--webpack")], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, NEXT_PUBLIC_SITE_VERSION: version },
});
child.on("error", (error) => { console.error(error); process.exit(1); });
child.on("exit", async (code) => {
  if (code !== 0) process.exit(code ?? 1);
  try { await verifyCodeProtection(path.resolve('.next')); }
  catch (error) { console.error(error); process.exit(1); }
});
