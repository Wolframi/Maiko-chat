import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const env = { ...process.env };
const rest = [];
for (const arg of args) {
  if (rest.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
    const split = arg.indexOf("=");
    env[arg.slice(0, split)] = arg.slice(split + 1);
    continue;
  }
  rest.push(arg);
}

let tsx;
try {
  tsx = require.resolve("tsx/cli");
} catch {
  console.error(
    "Зависимости не установлены. В корне проекта выполните: npm install",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [tsx, ...rest], {
  cwd: root,
  stdio: "inherit",
  env,
  windowsHide: true,
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
