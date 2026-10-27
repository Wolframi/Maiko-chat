import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "msedge", viewport: { width: 1280, height: 900 } });

async function register(page: Page, username: string) {
  await page.goto("/");
  await page.getByRole("tab", { name: "Регистрация", exact: true }).click();
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').nth(0).fill("RemovalTest123!");
  await page.locator('input[type="password"]').nth(1).fill("RemovalTest123!");
  await page.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

async function openDm(page: Page, username: string) {
  await page.getByRole("navigation", { name: "Серверы и группы" }).getByRole("button", { name: "Люди", exact: true }).click();
  await page.getByRole("textbox", { name: "Поиск людей и групп" }).fill(`@${username}`);
  await page.locator(".person-item").filter({ hasText: `@${username}` }).click();
  await expect(page.getByRole("textbox", { name: "Написать сообщение…" })).toBeVisible();
}

async function deleteDialog(page: Page) {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("menuitem", { name: "Удалить чат", exact: true }).click();
  return page.getByRole("dialog", { name: "Удалить чат?", exact: true });
}

test("delete a DM for self or both; leave a group as owner and last member", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses disposable local accounts");
  const first = await browser.newContext({ baseURL });
  const second = await browser.newContext({ baseURL });
  const stamp = Date.now();
  const aName = `delA${stamp}`;
  const bName = `delB${stamp}`;
  const errors: string[] = [];
  try {
    for (const context of [first, second]) {
      context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
      await context.route("**/api/ringtones?page=*", route => route.fulfill({ json: { items: [], page: 1, pages: 1 } }));
    }
    const a = await first.newPage();
    const b = await second.newPage();
    await register(a, aName);
    await register(b, bName);
    await openDm(a, bName);
    await a.getByRole("textbox", { name: "Написать сообщение…" }).fill("old history to remove");
    await a.getByRole("textbox", { name: "Написать сообщение…" }).press("Enter");
    await openDm(b, aName);
    await expect(b.locator(".room__messages")).toContainText("old history to remove");
    let dialog = await deleteDialog(a);
    await expect(dialog.getByRole("radio", { name: "Только у меня", exact: true })).toBeChecked();
    await a.screenshot({ path: testInfo.outputPath("delete-chat-options.png") });
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(a.locator(".room__messages")).toContainText("old history to remove");
    dialog = await deleteDialog(a);
    await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(b.locator(".room__messages")).toContainText("old history to remove");
    await a.reload();
    await expect(a.locator(".workspace")).toBeVisible();
    await expect(a.getByRole("textbox", { name: "Написать сообщение…" })).not.toBeVisible();
    await b.getByRole("textbox", { name: "Написать сообщение…" }).fill("new history remains");
    await b.getByRole("textbox", { name: "Написать сообщение…" }).press("Enter");
    await openDm(a, bName);
    await expect(a.locator(".room__messages")).toContainText("new history remains");
    await expect(a.locator(".room__messages")).not.toContainText("old history to remove");
    dialog = await deleteDialog(b);
    await dialog.getByRole("radio", { name: "У меня и собеседника", exact: true }).check();
    await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(a.getByRole("textbox", { name: "Написать сообщение…" })).not.toBeVisible();
    await openDm(a, bName);
    await expect(a.locator(".room__messages")).not.toContainText("new history remains");

    const title = `Leave ${stamp}`;
    const railA = a.getByRole("navigation", { name: "Серверы и группы" });
    await railA.getByRole("button", { name: "Создать группу", exact: true }).click();
    await a.getByRole("textbox", { name: "Название", exact: true }).fill(title);
    await a.locator(".sidebar__create").getByRole("button", { name: "Создать группу", exact: true }).click();
    await expect(railA.getByRole("button", { name: title, exact: true })).toBeVisible();
    await b.getByRole("navigation", { name: "Серверы и группы" }).getByRole("button", { name: "Люди", exact: true }).click();
    await b.getByRole("textbox", { name: "Поиск людей и групп" }).fill(title);
    await b.locator(".discover-group").filter({ hasText: title }).getByRole("button", { name: "Присоединиться", exact: true }).click();
    await expect(b.getByRole("textbox", { name: "Написать сообщение…" })).toBeVisible();
    await a.getByRole("button", { name: "Ещё", exact: true }).click();
    await a.getByRole("menuitem", { name: "Выйти из группы", exact: true }).click();
    let leave = a.getByRole("dialog", { name: "Выйти из группы?", exact: true });
    await expect(leave).toContainText("Права владельца перейдут");
    await leave.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(railA.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    await b.getByRole("button", { name: "Ещё", exact: true }).click();
    await b.getByRole("menuitem", { name: "Выйти из группы", exact: true }).click();
    leave = b.getByRole("dialog", { name: "Выйти из группы?", exact: true });
    await expect(leave).toContainText("Вы последний участник");
    await leave.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(b.getByRole("navigation", { name: "Серверы и группы" }).getByRole("button", { name: title, exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await first.close(); await second.close(); }
});
