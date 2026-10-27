import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { securityServer } from "./helpers/securityServer";

(async () => {
  const server = await securityServer();
  const require = createRequire(import.meta.url);
  try {
  const child = spawn(process.execPath, [require.resolve("@playwright/test/cli"), "test", "e2e/ringtone-sync.spec.ts", "--workers=1"], {
    stdio: "inherit", windowsHide: true, env: { ...process.env, PULSE_BASE_URL: server.base },
  });
  const status = await new Promise<number | null>(resolve => child.once("exit", resolve));
  if (status !== 0) process.exitCode = status || 1;
  } finally { await server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
