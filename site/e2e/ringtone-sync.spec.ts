import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "msedge", viewport: { width: 1280, height: 900 } });

const catalog = { items: [{ id: "sync-test", title: "Общий рингтон", url: "/api/ringtones/audio?u=https%3A%2F%2Fzvukogram.com%2Fmp3%2Fcats%2Fsync-test.mp3" }], page: 1, pages: 1, source: "test" };

function wav() {
  const samples = 22050;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 22050) * 1000), 44 + i * 2);
  return data;
}

async function login(page: Page, username: string) {
  await page.goto("/");
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').fill("Ringtone123!");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

async function profile(page: Page) {
  if (!await page.getByRole("tab", { name: "Рингтон", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Открыть профиль", exact: true }).click();
  }
  await page.getByRole("tab", { name: "Рингтон", exact: true }).click();
  await page.getByRole("searchbox", { name: "Поиск музыки на YouTube" }).fill("sync");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(page.locator(".profile__ringtone-select").filter({ hasText: "Общий рингтон" })).toBeVisible();
}

async function register(page: Page, username: string) {
  await page.getByRole("tab", { name: "Регистрация", exact: true }).click();
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').nth(0).fill("Ringtone123!");
  await page.locator('input[type="password"]').nth(1).fill("Ringtone123!");
  await page.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

test("a ringtone, custom clip and reset stay identical in separate sessions and after a fresh login", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses disposable local accounts only");
  const a = await browser.newContext({ baseURL });
  const b = await browser.newContext({ baseURL });
  const c = await browser.newContext({ baseURL });
  const errors: string[] = [];
  const username = `rt${Date.now()}`;
  try {
    for (const context of [a, b, c]) {
      await context.addInitScript(() => {
        const original = HTMLMediaElement.prototype.play;
        const played: HTMLMediaElement[] = [];
        (window as unknown as { ringtonePlayers: HTMLMediaElement[] }).ringtonePlayers = played;
        HTMLMediaElement.prototype.play = function () { played.push(this); return original.call(this); };
      });
      await context.route("**/api/ringtones?page=*", route => {
        expect(route.request().headers()["x-pulse-token"]).toBeTruthy();
        return route.fulfill({ json: catalog });
      });
      await context.route("**/api/ringtones/audio?*", route => {
        expect(route.request().headers()["x-pulse-token"]).toBeTruthy();
        return route.fulfill({ contentType: "audio/wav", body: wav() });
      });
    }
    const first = await a.newPage();
    const second = await b.newPage();
    const fresh = await c.newPage();
    for (const page of [first, second, fresh]) page.on("pageerror", error => errors.push(error.message));
    await first.goto("/");
    await first.getByRole("tab", { name: "Регистрация", exact: true }).click();
    await first.getByPlaceholder("artem").fill(username);
    await first.locator('input[type="password"]').nth(0).fill("Ringtone123!");
    await first.locator('input[type="password"]').nth(1).fill("Ringtone123!");
    await first.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
    await expect(first.locator(".workspace")).toBeVisible();
    await login(second, username);
    await profile(first);
    await profile(second);
    const tone = first.locator(".profile__ringtone-row").filter({ hasText: "Общий рингтон" });
    await tone.getByRole("button", { name: "Прослушать", exact: true }).click();
    await first.waitForFunction(() => (window as unknown as { ringtonePlayers: HTMLMediaElement[] }).ringtonePlayers.some(audio => audio.src.startsWith("blob:") && audio.currentTime > 0));
    await tone.getByRole("button", { name: "Остановить", exact: true }).click();
    await first.locator(".profile__ringtone-select").filter({ hasText: "Общий рингтон" }).click();
    await expect(first.locator(".profile__ringtone-now")).toContainText("Общий рингтон");
    await expect(second.locator(".profile__ringtone-now")).toContainText("Общий рингтон");

    await first.locator('input[type="file"][accept*="audio"]').setInputFiles({ name: "Мой сигнал.wav", mimeType: "audio/wav", buffer: wav() });
    const trim = first.getByRole("dialog", { name: "Обрезать рингтон" });
    await expect(trim).toBeVisible();
    await expect(trim.getByRole("button", { name: "Готово", exact: true })).toBeEnabled();
    await trim.getByRole("button", { name: "Готово", exact: true }).click();
    await expect(trim).not.toBeVisible();
    await expect(first.locator(".profile__ringtone-now")).toContainText("Мой сигнал");
    await expect(second.locator(".profile__ringtone-now")).toContainText("Мой сигнал");

    await login(fresh, username);
    await profile(fresh);
    await expect(fresh.locator(".profile__ringtone-now")).toContainText("Мой сигнал");
    const audio = await fresh.evaluate(async () => {
      const response = await fetch("/api/ringtones/preference", { headers: { "x-pulse-token": localStorage.getItem("pulse-chat-token")! } });
      const { settings } = await response.json();
      const clip = await fetch(settings.custom.url);
      const source = await fetch(settings.custom.source.url);
      const bytes = new Uint8Array(await clip.arrayBuffer());
      return { clipStatus: clip.status, sourceStatus: source.status, magic: new TextDecoder().decode(bytes.slice(0, 4)), name: settings.custom.source.name };
    });
    expect(audio).toEqual({ clipStatus: 200, sourceStatus: 200, magic: "RIFF", name: "Мой сигнал.wav" });
    await second.locator(".profile__ringtone-select").filter({ hasText: "Стандартный сигнал" }).click();
    for (const page of [first, second, fresh]) await expect(page.locator(".profile__ringtone-now")).toContainText("стандартный сигнал");
    await fresh.reload();
    await expect(fresh.locator(".workspace")).toBeVisible();
    await profile(fresh);
    await expect(fresh.locator(".profile__ringtone-now")).toContainText("стандартный сигнал");
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});

test("an existing local custom ringtone migrates to the account and never follows a different user", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses disposable local accounts only");
  const a = await browser.newContext({ baseURL });
  const b = await browser.newContext({ baseURL });
  const username = `rm${Date.now()}`;
  try {
    for (const context of [a, b]) {
      await context.route("**/api/ringtones?page=*", route => route.fulfill({ json: catalog }));
      await context.route("**/api/ringtones/audio?*", route => route.fulfill({ contentType: "audio/wav", body: wav() }));
    }
    const first = await a.newPage();
    const second = await b.newPage();
    await first.goto("/");
    await first.getByPlaceholder("artem").waitFor();
    await first.evaluate(async bytes => {
      const blob = new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pulse-ringtone", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("clips");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("clips", "readwrite");
        tx.objectStore("clips").put(blob, "custom");
        tx.objectStore("clips").put({ blob, name: "legacy.wav", startSec: 0, endSec: 1 }, "custom-source");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      localStorage.setItem("pulse-ringtone", JSON.stringify({ id: "custom", title: "Старый рингтон", url: "idb:custom", startSec: 0 }));
    }, [...wav()]);
    await register(first, username);
    await profile(first);
    await expect(first.locator(".profile__ringtone-now")).toContainText("Старый рингтон");
    await expect.poll(() => first.evaluate(async () => {
      const r = await fetch("/api/ringtones/preference", { headers: { "x-pulse-token": localStorage.getItem("pulse-chat-token")! } });
      return (await r.json()).settings.custom?.title;
    })).toBe("Старый рингтон");
    await login(second, username);
    await profile(second);
    await expect(second.locator(".profile__ringtone-now")).toContainText("Старый рингтон");
    await second.getByRole("tab", { name: "Аккаунт", exact: true }).click();
    await second.getByRole("button", { name: "Выйти", exact: true }).click();
    await second.getByPlaceholder("artem").waitFor();
    await register(second, `other${Date.now()}`);
    await profile(second);
    await expect(second.locator(".profile__ringtone-now")).toContainText("стандартный сигнал");
    await expect(first.locator(".profile__ringtone-now")).toContainText("Старый рингтон");
  } finally { await Promise.all([a.close(), b.close()]); }
});
