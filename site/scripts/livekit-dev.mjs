#!/usr/bin/env node
/**
 * Локальный LiveKit SFU для голосовых каналов Майко.
 *
 *   npm run livekit
 *
 * При первом запуске скачивает livekit-server нужной платформы в
 * site/tools/livekit и запускает его в dev-режиме (devkey/secret,
 * ws://127.0.0.1:7880). На сервере Linux можно поставить livekit-server
 * системно и запускать без этого скрипта — сервер Майко сам найдёт 7880.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = process.env.LIVEKIT_VERSION || "1.13.11";
const TOOLS_DIR = path.join(SITE_ROOT, "tools", "livekit");
const isWindows = process.platform === "win32";
const BINARY = path.join(TOOLS_DIR, isWindows ? "livekit-server.exe" : "livekit-server");
const LOCAL_URL = "http://127.0.0.1:7880";

function assetName() {
  if (process.platform === "win32") {
    return `livekit_${VERSION}_windows_${process.arch === "arm64" ? "arm64" : "amd64"}.zip`;
  }
  if (process.platform === "linux") {
    return `livekit_${VERSION}_linux_${process.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`;
  }
  return null;
}

async function alreadyRunning() {
  try {
    const response = await fetch(LOCAL_URL, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function download() {
  const asset = assetName();
  if (!asset) {
    console.error(
      `Автоскачивание LiveKit для ${process.platform} не поддерживается.\n` +
        "Установите livekit-server вручную: https://github.com/livekit/livekit/releases",
    );
    process.exit(1);
  }
  const url = `https://github.com/livekit/livekit/releases/download/v${VERSION}/${asset}`;
  console.log(`[livekit] скачиваю ${asset}…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) {
    throw new Error(`GitHub вернул HTTP ${response.status}. Скачайте ${url} вручную.`);
  }
  mkdirSync(TOOLS_DIR, { recursive: true });
  const archive = path.join(TOOLS_DIR, asset);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const tar = spawnSync("tar", ["-xf", archive, "-C", TOOLS_DIR], { stdio: "inherit" });
  if (tar.status !== 0 && isWindows) {
    const powershell = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${TOOLS_DIR}' -Force`,
      ],
      { stdio: "inherit" },
    );
    if (powershell.status !== 0) throw new Error("Не удалось распаковать архив LiveKit");
  }
  rmSync(archive, { force: true });
  if (!existsSync(BINARY)) {
    throw new Error(`После распаковки не найден ${BINARY}`);
  }
  if (!isWindows) chmodSync(BINARY, 0o755);
  console.log(`[livekit] установлен: ${BINARY}`);
}

if (await alreadyRunning()) {
  console.log("[livekit] уже запущен на ws://127.0.0.1:7880");
  process.exit(0);
}

if (!existsSync(BINARY)) {
  try {
    await download();
  } catch (error) {
    console.error(`[livekit] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const child = spawn(BINARY, args.length ? args : ["--dev"], {
  cwd: SITE_ROOT,
  stdio: "inherit",
});
console.log("[livekit] запускаю SFU: ws://127.0.0.1:7880 (devkey/secret)");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on("exit", (code, signal) => {
  if (signal) console.log(`[livekit] остановлен (${signal})`);
  process.exit(code ?? 0);
});
