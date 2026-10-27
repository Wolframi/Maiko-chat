import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "msedge", viewport: { width: 1280, height: 900 } });

async function register(page: Page, username: string) {
  await page.goto("/");
  await page.getByRole("tab", { name: "Регистрация", exact: true }).click();
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').nth(0).fill("InviteCodeTest123!");
  await page.locator('input[type="password"]').nth(1).fill("InviteCodeTest123!");
  await page.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

test("a private group is shared by code instead of user invitations and can be joined from People", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(240000);
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses disposable local accounts");
  const ownerContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  try {
    for (const context of [ownerContext, guestContext]) {
      await context.route("**/api/ringtones?page=*", route => route.fulfill({ json: { items: [], page: 1, pages: 1 } }));
      context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    }
    const owner = await ownerContext.newPage();
    const guest = await guestContext.newPage();
    const stamp = Date.now();
    await register(owner, `invite${stamp}`);
    await register(guest, `guest${stamp}`);
    const title = `Closed ${stamp}`;
    const ownerRail = owner.getByRole("navigation", { name: "Серверы и группы" });
    await ownerRail.getByRole("button", { name: "Создать группу", exact: true }).click();
    await owner.getByRole("textbox", { name: "Название", exact: true }).fill(title);
    await owner.getByRole("radio", { name: /Закрытая/ }).check();
    await owner.locator(".sidebar__create").getByRole("button", { name: "Создать группу", exact: true }).click();
    const invitation = owner.getByRole("button", { name: "Скопировать код приглашения", exact: true });
    await expect(invitation).toBeVisible();
    await expect(owner.getByRole("textbox", { name: "Код приглашения", exact: true })).toHaveCount(0);
    await expect(owner.getByRole("textbox", { name: "Пригласить в группу", exact: true })).toHaveCount(0);
    await expect(owner.locator('.workspace__sidebar .room__invite-btn')).toHaveCount(0);
    await owner.bringToFront();
    await invitation.click();
    await expect(owner.getByText("Код приглашения скопирован", { exact: true })).toBeVisible();
    const code = await owner.evaluate(() => navigator.clipboard.readText());
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){2}$/);
    await expect(owner.getByText(code, { exact: true })).toHaveCount(0);
    await owner.screenshot({ path: testInfo.outputPath("invite-code.png") });

    await guest.getByRole("navigation", { name: "Серверы и группы" }).getByRole("button", { name: "Люди", exact: true }).click();
    const search = guest.getByRole("textbox", { name: "Поиск людей и групп" });
    await search.fill(title);
    await expect(guest.locator(".discover-group").filter({ hasText: title })).toHaveCount(0);
    const input = guest.getByRole("textbox", { name: "Код для вступления", exact: true });
    await input.fill("INVALID");
    await guest.getByRole("button", { name: "Вступить", exact: true }).click();
    await expect(guest.getByRole("form", { name: "Вступить по коду" }).getByRole("alert")).toContainText("недействителен или устарел");
    await input.fill(code.toLowerCase());
    await guest.getByRole("button", { name: "Вступить", exact: true }).click();
    await expect(guest.getByRole("navigation", { name: "Серверы и группы" }).getByRole("button", { name: title, exact: true })).toBeVisible();
    await expect(guest.getByRole("button", { name: "Скопировать код приглашения", exact: true })).toBeVisible();
    const message = guest.getByRole("textbox", { name: "Написать сообщение…" });
    await message.fill(`Joined by code ${stamp}`);
    await message.press("Enter");
    await expect(owner.locator(".room__messages")).toContainText(`Joined by code ${stamp}`);
    await guest.reload();
    await guest.getByRole("navigation", { name: "Серверы и группы" }).getByRole("button", { name: title, exact: true }).click();
    await expect(guest.getByRole("button", { name: "Скопировать код приглашения", exact: true })).toBeVisible();
    await owner.setViewportSize({ width: 390, height: 844 });
    if (await owner.locator(".workspace__sidebar").evaluate(element => element.classList.contains("is-open"))) {
      await owner.getByRole("button", { name: "Закрыть меню", exact: true }).click();
    }
    await expect(invitation).toBeVisible();
    await invitation.click();
    expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await owner.screenshot({ path: testInfo.outputPath("invite-code-mobile.png") });
    expect(errors).toEqual([]);
  } finally { await ownerContext.close(); await guestContext.close(); }
});
