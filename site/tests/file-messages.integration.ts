import assert from "node:assert/strict";
import { test } from "node:test";
import { io } from "socket.io-client";
import { securityServer } from "./helpers/securityServer";

test("uploaded documents, scripts and unknown formats reach chat history", { timeout: 180_000 }, async () => {
  const server = await securityServer();
  const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    const request = (event: string, payload: unknown) => socket.timeout(10_000).emitWithAck(event, payload);
    const login = await request("auth:login", { username: "seeduser0", password: server.password });
    assert.equal(login.ok, true, login.error);
    const opened = await request("chats:switch", { chatId: "security-group-0" });
    assert.equal(opened.ok, true, opened.error);
    const files = [];
    for (const name of ["page.html", "source.js", "image.svg", "config.xml", "module.wasm", "script.ps1", "program.exe", "Отчёт.docx", "unknown.custom", "empty.txt"]) {
      const form = new FormData();
      form.append("originalName", name);
      form.append("file", new Blob([name === "empty.txt" ? "" : "attachment bytes"]), "upload.bin");
      const uploaded = await (await fetch(server.base + "/api/upload", { method: "POST", headers: { origin: server.base, "x-pulse-token": server.token }, body: form })).json();
      assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
      files.push(uploaded.file);
    }
    for (const [index, file] of files.entries()) {
      const sent = await request("message:file", { chatId: "security-group-0", file, clientId: `arbitrary-format-${index}` });
      assert.equal(sent.ok, true, sent.error);
      // Respect the normal chat limit of five messages per second.
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const history = new Promise<{ messages: { file?: { name: string; url: string; size: number } }[] }>(resolve => socket.once("history", resolve));
    assert.equal((await request("chats:switch", { chatId: "security-group-0" })).ok, true);
    const messages = (await history).messages;
    assert.deepEqual(messages.map(message => message.file?.name), files.map(file => file.name));
    assert.equal(messages.at(-1)?.file?.size, 0);
  } finally {
    socket.disconnect();
    await server.stop();
  }
});
