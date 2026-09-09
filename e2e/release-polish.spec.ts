import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.PULSE_BASE_URL || "http://127.0.0.1:3000";

async function ensureLoggedOut(page: Page) {
  await page.goto(BASE);
  const profile = page.getByRole("button", { name: "Открыть профиль" });
  if (await profile.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await profile.click();
    const logout = page.getByRole("button", { name: "Выйти" });
    if (await logout.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await logout.click();
    }
  }
  await expect(page.getByPlaceholder("artem")).toBeVisible({ timeout: 20_000 });
}

async function login(page: Page, username: string, password: string) {
  await ensureLoggedOut(page);
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".workspace")).toBeVisible({ timeout: 20_000 });
}

async function openDm(page: Page, query: string, label: RegExp) {
  const rail = page.getByRole("navigation", { name: "Серверы и группы" });
  await rail.getByRole("button", { name: "Люди" }).click({ force: true });
  await page.getByRole("textbox", { name: "Поиск людей" }).fill(query);
  const person = page
    .locator(".people-list button, .sidebar button")
    .filter({ hasText: label })
    .first();
  await expect(person).toBeVisible({ timeout: 10_000 });
  await person.click();
  await expect(
    page.getByRole("textbox", { name: "Написать сообщение…" }),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("Pulse release polish", () => {
  test("fullscreen shell + message + voice UI + call soft-path + logout", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["microphone", "camera"]);

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await login(page, "artem", "Artem1234!");

    const geometry = await page.evaluate(() => {
      const ws = document.querySelector(".workspace");
      if (!ws) return null;
      const r = ws.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        vw: window.innerWidth,
        vh: window.innerHeight,
        radius: getComputedStyle(ws).borderRadius,
      };
    });
    expect(geometry).toBeTruthy();
    expect(geometry!.x).toBeLessThanOrEqual(2);
    expect(geometry!.y).toBeLessThanOrEqual(2);
    expect(geometry!.w).toBeGreaterThanOrEqual(geometry!.vw - 4);
    expect(geometry!.h).toBeGreaterThanOrEqual(geometry!.vh - 4);
    expect(["0px", "0"].includes(geometry!.radius)).toBeTruthy();

    const rail = page.getByRole("navigation", { name: "Серверы и группы" });
    await rail.getByRole("button", { name: "Люди" }).click();
    await expect(page.getByText("Найти и написать")).toBeVisible();
    await rail.getByRole("button", { name: "Чаты" }).click({ force: true });
    await expect(page.getByText("Диалоги").first()).toBeVisible();

    await openDm(page, "alice", /Алиса/i);
    const draft = `E2E ${Date.now()}`;
    await page.getByRole("textbox", { name: "Написать сообщение…" }).fill(draft);
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(page.locator(".bubble__text", { hasText: draft })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: "Голосовое сообщение" }).click();
    await expect(
      page.getByRole("button", { name: "Удалить запись" }),
    ).toBeVisible({ timeout: 8_000 });
    await page.getByRole("button", { name: "Удалить запись" }).click();

    // Offline peer → call buttons disabled (soft UX, no crash).
    await expect(page.getByRole("button", { name: "Видеозвонок" })).toBeDisabled();

    await page.getByRole("button", { name: "Открыть профиль" }).click();
    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.getByPlaceholder("artem")).toBeVisible({ timeout: 15_000 });

    expect(pageErrors).toEqual([]);
  });
});
