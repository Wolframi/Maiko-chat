import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { io as connect } from "socket.io-client";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureDesktopUpdateNotifications } from "../src/server/desktopUpdateNotifications";

test("publication reaches every connected WebSocket client and a reconnect receives the latest release", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "maiko-update-notice-"));
  const filename = path.join(directory, "desktop-release.json");
  const http = createServer();
  const server = new Server(http, { path: "/api/socket" });
  const dispose = configureDesktopUpdateNotifications(server, filename);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const clients: ReturnType<typeof connect>[] = [];
  function client(namespace: string) {
    const socket = connect(origin + namespace, { path: "/api/socket", transports: ["websocket"], forceNew: true });
    clients.push(socket); return socket;
  }
  function notice(socket: ReturnType<typeof connect>) {
    return new Promise<{ version: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket notice timed out")), 10_000);
      socket.once("desktop:update-available", value => { clearTimeout(timer); resolve(value); });
    });
  }
  try {
    const first = client("/desktop-updates"), second = client("/desktop-updates"), website = client("");
    await Promise.all([first, second, website].map(socket => new Promise<void>(resolve => socket.once("connect", resolve))));
    assert.ok(clients.every(socket => socket.io.engine.transport.name === "websocket"));
    const broadcasts = [first, second, website].map(notice);
    writeFileSync(filename + ".pending", JSON.stringify({ version: "1.1.14" }));
    renameSync(filename + ".pending", filename);
    assert.deepEqual(await Promise.all(broadcasts), [{ version: "1.1.14" }, { version: "1.1.14" }, { version: "1.1.14" }]);
    const returning = client("/desktop-updates");
    assert.deepEqual(await notice(returning), { version: "1.1.14" });
  } finally {
    dispose(); clients.forEach(socket => socket.disconnect());
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
