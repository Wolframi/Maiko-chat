import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scryptSync } from "node:crypto";
import { MessageStore } from "../../src/server/messageStore";

export async function securityServer(options: { registrationRequired?: boolean; historyMessages?: number; mongo?: { uri: string; database: string } } = {}) {
  const site = fileURLToPath(new URL("../../", import.meta.url));
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-http-security-"));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  for (const name of ["server.ts", "next.config.ts", "tsconfig.json", "package.json", "postcss.config.mjs", "src"]) cpSync(path.join(site, name), path.join(folder, name), { recursive: true });
  for (const name of ["node_modules", ".next", "public"]) symlinkSync(path.join(site, name), path.join(folder, name), process.platform === "win32" ? "junction" : "dir");
  mkdirSync(path.join(folder, "data"));
  const password = "SecurityFixture123!";
  const passwordHash = "security-salt:" + scryptSync(password, "security-salt", 64).toString("hex");
  const photo = "/uploads/00000000-0000-4000-8000-000000000000.png";
  mkdirSync(path.join(folder, "uploads"));
  writeFileSync(path.join(folder, photo), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  const users = Array.from({ length: 55 }, (_, i) => ({ id: `security-user-${i}`, username: `seeduser${i}`, displayName: `Seed User ${i}`, passwordHash, createdAt: Date.now(), bio: "private-bio", lastSeenAt: 123, avatarUrl: photo }));
  const token = "security-fixture-session";
  writeFileSync(path.join(folder, "data/users.json"), JSON.stringify(users));
  writeFileSync(path.join(folder, "data/registration-invites.json"), JSON.stringify({ required: options.registrationRequired ?? false, adminUserId: users[0].id, secret: "a".repeat(64) }));
  writeFileSync(path.join(folder, "data/sessions.json"), JSON.stringify([{ token, userId: users[0].id, issuedAt: Date.now() }]));
  const groups = Array.from({ length: 40 }, (_, i) => ({ id: `security-group-${i}`, type: "group", title: `Seed Group ${i}`, topic: "seed topic", memberIds: i === 0 ? [users[0].id, users[1].id] : [users[1].id], createdAt: Date.now(), createdBy: users[1].id, visibility: "public" }));
  groups.push({ ...groups[0], id: "oversized", title: "Oversized", memberIds: [users[0].id, ...Array.from({ length: 50 }, (_, i) => `legacy-missing-${i}`)] });
  writeFileSync(path.join(folder, "data/chats.json"), JSON.stringify(groups));
  if (options.historyMessages) {
    const messages = Array.from({ length: options.historyMessages }, (_, index) => ({
      id: `history-${index}`, room: groups[0].id, authorId: users[0].id, author: "Seed User 0",
      text: index === 6 ? "Seed User 0 в чате" : `History message ${index}`,
      kind: index === 6 ? "system" : "text", createdAt: 1700000000000 + Math.floor(index / 3),
      ...(index === 5 ? { hiddenFor: [users[0].id] } : {}),
      ...(index === options.historyMessages! - 1 ? { replyTo: { id: "history-12", author: "Seed User 0", text: "History message 12" } } : {}),
    }));
    writeFileSync(path.join(folder, "data/messages.json"), JSON.stringify({ [groups[0].id]: messages }));
  }
  if (options.mongo) {
    const store = new MessageStore(options.mongo.uri, options.mongo.database);
    try {
      await store.connect();
      if (!options.historyMessages) writeFileSync(path.join(folder, "data/messages.json"), "{}");
      await store.migrate(path.join(folder, "data/messages.json"));
    } finally { await store.close(); }
  }
  const secret = "security-fixture-turn-secret-" + "x".repeat(40);
  const child = spawn(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, "server.ts"], {
    cwd: folder, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, SEED_DEMO: "0", NEXT_PUBLIC_DEMO: "0", MONGODB_URI: options.mongo?.uri ?? "", MONGODB_DATABASE: options.mongo?.database ?? "maiko", MEDIA_STORAGE: "local", GIPHY_API_KEY: "", TURN_AUTH_SECRET: secret, TURN_HOST: "relay.example.com" },
  });
  let logs = "";
  child.stdout.on("data", data => { logs = (logs + data).slice(-12000); });
  child.stderr.on("data", data => { logs = (logs + data).slice(-12000); });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
    if (path.dirname(folder) !== path.resolve(tmpdir()) || !path.basename(folder).startsWith("maiko-http-security-")) throw new Error("Invalid fixture path");
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    const deadline = Date.now() + (process.platform === "win32" ? 120000 : 60000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).ok) return { base, token, password, secret, stop, logs: () => logs }; } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("Fixture startup timed out: " + logs);
  } catch (error) { await stop(); throw error; }
}
