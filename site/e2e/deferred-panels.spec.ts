import { expect, test } from "@playwright/test";
import { appServer } from "./helpers/appServer";

let server: Awaited<ReturnType<typeof appServer>>;
test.use({ channel: "msedge", contextOptions: { reducedMotion: "reduce" } });
test.beforeAll(async () => { test.setTimeout(180000); server = await appServer(); });
test.afterAll(async () => { await server?.stop(); });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(token => {
    localStorage.setItem("pulse-chat-token", token);
    localStorage.setItem("pulse-krisp", "0");
    localStorage.setItem("pulse-browser-ns", "0");
  }, server.token);
  await page.goto(server.base);
  await expect(page.locator(".workspace")).toBeVisible();
});

test("profile loads on first open, stays cached and closes normally", async ({ page }) => {
  const scripts = new Set<string>();
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith(".js")) scripts.add(request.url()); });
  await page.waitForTimeout(1000);
  const before = scripts.size;
  await page.getByRole("button", { name: "Открыть профиль", exact: true }).click();
  const profile = page.getByRole("dialog", { name: "Профиль", exact: true });
  await expect(profile).toBeVisible();
  expect(scripts.size).toBeGreaterThan(before);
  await profile.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(profile).toHaveCount(0);
  await page.waitForTimeout(500);
  const loaded = scripts.size;
  await page.getByRole("button", { name: "Открыть профиль", exact: true }).click();
  await expect(profile).toBeVisible();
  expect(scripts.size).toBe(loaded);
});

test("failed optional chunk leaves the composer usable and can be retried", async ({ page }) => {
  await page.getByRole("button", { name: "Seed Group 0", exact: true }).click();
  const composer = page.getByPlaceholder("Написать сообщение…");
  await composer.fill("Message survives a failed panel download");
  let fail = true;
  await page.route("**/_next/static/chunks/**", route => {
    if (fail && new URL(route.request().url()).pathname.endsWith(".js")) { fail = false; return route.abort("failed"); }
    return route.continue();
  });
  await page.getByRole("button", { name: "Открыть профиль", exact: true }).click();
  const error = page.locator(".feature-load-error");
  await expect(error).toBeVisible();
  await expect(composer).toHaveValue("Message survives a failed panel download");
  await error.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Профиль", exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Профиль", exact: true }).getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(composer).toHaveValue("Message survives a failed panel download");
});

test("emoji, sticker and GIF tabs still open from the composer", async ({ page }) => {
  await page.route("**/api/gif**", route => route.fulfill({ json: { data: [], pagination: { total_count: 0 } } }));
  await page.getByRole("button", { name: "Seed Group 0", exact: true }).click();
  await page.getByRole("button", { name: "Открыть эмодзи, стикеры, GIF", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Эмодзи", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "GIF", exact: true }).click();
  await expect(page.getByPlaceholder("Поиск GIF...")).toBeVisible();
  await page.getByRole("tab", { name: "Стикеры", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Стикеры", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Закрыть панель", exact: true }).click();
  await expect(page.getByRole("button", { name: "Открыть эмодзи, стикеры, GIF", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("tab", { name: "Стикеры", exact: true })).toHaveCount(0);
});
