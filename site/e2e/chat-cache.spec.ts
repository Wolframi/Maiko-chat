import { expect, test, type Page } from "@playwright/test";
import { io, type Socket } from "socket.io-client";
import { appServer } from "./helpers/appServer";

let server: Awaited<ReturnType<typeof appServer>>;
test.use({ channel: "msedge", contextOptions: { reducedMotion: "reduce" } });
test.beforeAll(async () => { test.setTimeout(180_000); server = await appServer(160); });
test.afterAll(async () => { await server?.stop(); });

async function enter(page: Page, token = server.token) {
  await page.goto(server.base + "/api/health");
  await page.evaluate(token => { localStorage.setItem("pulse-chat-token", token); localStorage.setItem("pulse-krisp", "0"); }, token);
  await page.goto(server.base);
  await expect(page.locator(".workspace")).toBeVisible();
  await page.getByRole("button", { name: "Seed Group 0", exact: true }).click();
  await expect(page.locator("#msg-history-159")).toBeVisible();
}

async function records(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("maiko-chat-cache", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Array<{ key: string; revoked?: boolean; snapshot?: import("../src/lib/chatCache").ChatCacheSnapshot }>>((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

async function waitSaved(page: Page) {
  await expect.poll(async () => (await records(page)).some(record => record.snapshot?.rooms.some(room =>
    room.chatId === "security-group-0" && room.messages.some(message => message.id === "history-159")))).toBe(true);
}

async function peer() {
  const socket = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false, auth: { historyPages: 1, chatPatches: 1 } });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  expect((await emit(socket, "auth:restore", { token: server.token })).ok).toBe(true);
  return socket;
}
const emit = (socket: Socket, event: string, payload: object) => socket.timeout(15_000).emitWithAck(event, payload);

test("restart shows disk history before networking, then reconciles edits and deletions", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await enter(page);
  await waitSaved(page);
  const saved = await records(page);
  expect(JSON.stringify(saved)).not.toContain(server.token);
  expect(saved.find(record => record.snapshot)?.snapshot?.rooms[0].messages).toHaveLength(80);
  // Session memory and last-room sessionStorage are absent after this restart.
  await page.evaluate(() => sessionStorage.clear());
  await page.route("**/api/socket/**", route => route.abort());
  await page.reload();
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.locator("#msg-history-159")).toContainText("History message 159");
  await expect(page.locator(".reconnect-banner")).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toBeDisabled();
  await page.screenshot({ path: "../output/chat-cache/cached-restart.png" });
  const socket = await peer();
  try {
    expect((await emit(socket, "message:edit", { chatId: "security-group-0", messageId: "history-159", text: "Edited while client was offline" })).ok).toBe(true);
    expect((await emit(socket, "message:delete", { chatId: "security-group-0", messageId: "history-158" })).ok).toBe(true);
  } finally { socket.disconnect(); }
  await page.unroute("**/api/socket/**");
  await expect(page.locator("#msg-history-159")).toContainText("Edited while client was offline", { timeout: 30_000 });
  await expect(page.locator(".room__messages")).not.toContainText("History message 158");
  await expect(page.getByPlaceholder("Написать сообщение…")).toBeEnabled();
  await expect.poll(async () => (await records(page)).some(record => record.snapshot?.rooms.some(room =>
    room.messages.some(message => message.id === "history-159" && message.text === "Edited while client was offline")))).toBe(true);
  await page.reload();
  await expect(page.locator("#msg-history-159")).toContainText("Edited while client was offline");
  expect(errors).toEqual([]);
});

test("cache failures leave ordinary online authentication and chat usable", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("Storage denied", "SecurityError"); } }); });
  await enter(page);
  await expect(page.getByPlaceholder("Написать сообщение…")).toBeEnabled();
});

test("another account cannot read the previous session's disk cache", async ({ page }) => {
  await enter(page); await waitSaved(page);
  await page.evaluate(() => { localStorage.setItem("pulse-chat-token", "unrelated-token"); sessionStorage.clear(); });
  await page.route("**/api/socket/**", route => route.abort());
  await page.reload();
  await page.waitForTimeout(1800);
  await expect(page.locator(".workspace")).toHaveCount(0);
  await expect(page.locator("#msg-history-159")).toHaveCount(0);
});

test("a rejected server restore removes the cached conversation and credentials", async ({ page }) => {
  const socket = await peer();
  try {
    const login = await emit(socket, "auth:login", { username: "seeduser0", password: "SecurityFixture123!" });
    expect(login.ok).toBe(true);
    const token: string = login.account.token;
    await enter(page, token); await waitSaved(page);
    await page.route("**/api/socket/**", route => route.abort());
    await page.reload();
    await expect(page.locator("#msg-history-159")).toBeVisible();
    await expect(page.locator(".composer textarea")).toBeDisabled();
    socket.emit("auth:logout");
    // The logout handler is asynchronous; wait for server-side invalidation.
    await expect.poll(async () => (await emit(socket, "auth:restore", { token })).ok).toBe(false);
    await page.unroute("**/api/socket/**");
    await expect(page.locator(".workspace")).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pulse-chat-token"))).toBeNull();
    await expect.poll(async () => (await records(page)).filter(record => record.snapshot).length).toBe(0);
  } finally { socket.disconnect(); }
});

test("logout clears the snapshot and hides the same session in other tabs", async ({ page, context }) => {
  await enter(page); await waitSaved(page);
  const other = await context.newPage();
  await other.goto(server.base);
  await expect(other.locator(".workspace")).toBeVisible();
  await page.getByRole("button", { name: "Открыть профиль", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Профиль", exact: true });
  await expect(profile).toBeVisible();
  await profile.getByRole("button", { name: /Выйти/ }).click();
  await expect(page.locator(".workspace")).toHaveCount(0);
  await expect(other.locator(".workspace")).toHaveCount(0);
  await expect.poll(async () => (await records(page)).filter(record => record.snapshot).length).toBe(0);
  await page.reload();
  await expect(page.locator(".workspace")).toHaveCount(0);
  await other.close();
});
