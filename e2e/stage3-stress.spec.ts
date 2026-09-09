import { expect, test, type Browser, type Page } from "@playwright/test";

const BASE = process.env.PULSE_BASE_URL || "http://127.0.0.1:3000";

async function loginFresh(page: Page, username: string, password: string) {
  await page.goto(BASE);
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  const userField = page.getByPlaceholder("artem");
  const workspace = page.locator(".workspace");
  await Promise.race([
    userField.waitFor({ state: "visible", timeout: 25_000 }),
    workspace.waitFor({ state: "visible", timeout: 25_000 }),
  ]).catch(() => undefined);

  if (await workspace.isVisible().catch(() => false)) {
    const profile = page.getByRole("button", { name: "Открыть профиль" });
    if (await profile.isVisible().catch(() => false)) {
      await profile.click();
      const logout = page.getByRole("button", { name: "Выйти" });
      if (await logout.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await logout.click();
      }
    }
  }

  await expect(userField).toBeVisible({ timeout: 25_000 });
  await userField.fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.locator(".workspace")).toBeVisible({ timeout: 25_000 });
}

async function openGroup(page: Page, title: string | RegExp) {
  const rail = page.getByRole("navigation", { name: "Серверы и группы" });
  await rail.getByRole("button", { name: title }).click({ force: true });
  await expect(
    page.getByRole("textbox", { name: "Написать сообщение…" }),
  ).toBeVisible({ timeout: 10_000 });
}

async function sendText(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Написать сообщение…" }).fill(text);
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.locator(".bubble__text", { hasText: text })).toBeVisible({
    timeout: 12_000,
  });
}

async function createGroup(page: Page, title: string) {
  const rail = page.getByRole("navigation", { name: "Серверы и группы" });
  await rail.getByRole("button", { name: "Создать группу" }).click({ force: true });
  await page.getByRole("textbox", { name: "Название" }).fill(title);
  await page.getByRole("button", { name: "Создать группу" }).click();
  await expect(page.getByRole("textbox", { name: "Написать сообщение…" })).toBeVisible({
    timeout: 15_000,
  });
}

async function inviteUser(page: Page, query: string, label: RegExp) {
  await page.getByRole("textbox", { name: "Пригласить в группу" }).fill(query);
  const pick = page.locator(".member-pick").filter({ hasText: label }).first();
  await expect(pick).toBeVisible({ timeout: 10_000 });
  await pick.click();
}

async function acceptInvite(page: Page) {
  const rail = page.getByRole("navigation", { name: "Серверы и группы" });
  await rail.getByRole("button", { name: "Чаты" }).click({ force: true });
  const dm = page
    .locator(".room-item button, .sidebar__list button, button")
    .filter({ hasText: /Artem|Приглашение/i })
    .first();
  await expect(dm).toBeVisible({ timeout: 12_000 });
  await dm.click();
  const accept = page.getByRole("button", { name: "Принять" });
  await expect(accept).toBeVisible({ timeout: 12_000 });
  await accept.click();
  await expect(
    page.getByRole("textbox", { name: "Написать сообщение…" }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("Pulse stage 3 stress", () => {
  test("3 users chat + voice UI + call with screen share soft path", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    await contextA.grantPermissions(["microphone", "camera"]);
    await contextB.grantPermissions(["microphone", "camera"]);
    await contextC.grantPermissions(["microphone", "camera"]);

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

    const errors: string[] = [];
    for (const page of [pageA, pageB, pageC]) {
      page.on("pageerror", (err) => errors.push(String(err)));
    }

    await loginFresh(pageA, "artem", "Artem1234!");
    await loginFresh(pageB, "alice", "Alice1234!");
    await loginFresh(pageC, "bob", "Bob12345!");

    const groupTitle = `E2E ${Date.now().toString().slice(-6)}`;
    await createGroup(pageA, groupTitle);
    await inviteUser(pageA, "alice", /Алиса/i);
    await inviteUser(pageA, "bob", /Боб/i);

    await acceptInvite(pageB);
    await acceptInvite(pageC);

    await openGroup(pageA, groupTitle);
    await openGroup(pageB, groupTitle);
    await openGroup(pageC, groupTitle);

    const stamp = Date.now();
    await sendText(pageA, `A-hi ${stamp}`);
    await sendText(pageB, `B-hi ${stamp}`);
    await sendText(pageC, `C-hi ${stamp}`);

    await expect(pageA.locator(".bubble__text", { hasText: `B-hi ${stamp}` })).toBeVisible({
      timeout: 12_000,
    });
    await expect(pageA.locator(".bubble__text", { hasText: `C-hi ${stamp}` })).toBeVisible({
      timeout: 12_000,
    });

    await pageA.getByRole("textbox", { name: "Написать сообщение…" }).fill("@al");
    await expect(pageA.locator(".mention-menu")).toBeVisible({ timeout: 5_000 });
    await pageA.keyboard.press("Escape");

    await pageB.getByRole("button", { name: "Голосовое сообщение" }).click();
    await expect(
      pageB.getByRole("button", { name: "Удалить запись" }),
    ).toBeVisible({ timeout: 8_000 });
    await pageB.getByRole("button", { name: "Удалить запись" }).click();

    await pageA.locator(".bubble-row--mine .bubble").last().click({ button: "right" });
    await expect(pageA.getByRole("menu")).toBeVisible({ timeout: 5_000 });
    await expect(pageA.getByRole("menuitem", { name: "Изменить" })).toBeVisible();
    await expect(pageA.getByRole("menuitem", { name: "Переслать" })).toBeVisible();
    await expect(pageA.getByRole("menuitem", { name: "Закрепить" })).toBeVisible();
    await pageA.keyboard.press("Escape");

    await pageA
      .getByRole("navigation", { name: "Серверы и группы" })
      .getByRole("button", { name: "Люди" })
      .click({ force: true });
    await pageA.getByRole("textbox", { name: "Поиск людей" }).fill("alice");
    const aliceBtn = pageA.locator("button").filter({ hasText: /Алиса/i }).first();
    await expect(aliceBtn).toBeVisible({ timeout: 10_000 });
    await aliceBtn.click();

    const videoCall = pageA.getByRole("button", { name: "Видеозвонок" });
    if (await videoCall.isEnabled().catch(() => false)) {
      await videoCall.click();
      const answer = pageB.getByRole("button", { name: "Ответить" });
      if (await answer.isVisible({ timeout: 12_000 }).catch(() => false)) {
        await answer.click();
        await pageA.waitForTimeout(1200);
        const share = pageA.getByRole("button", { name: /Показать экран|экран/i }).first();
        if (await share.isVisible().catch(() => false)) {
          await share.click().catch(() => undefined);
          await pageA.waitForTimeout(600);
        }
        const endA = pageA.getByRole("button", { name: /Завершить/i }).first();
        if (await endA.isVisible().catch(() => false)) await endA.click();
        const endB = pageB.getByRole("button", { name: /Завершить|Отклонить/i }).first();
        if (await endB.isVisible().catch(() => false)) await endB.click();
      } else {
        const endA = pageA.getByRole("button", { name: /Завершить|Отклонить/i }).first();
        if (await endA.isVisible().catch(() => false)) await endA.click();
      }
    }

    expect(errors).toEqual([]);

    await contextA.close();
    await contextB.close();
    await contextC.close();
  });
});
