import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "msedge", viewport: { width: 1280, height: 900 } });
const password = "NicknameTest123!";

async function register(page: Page, username: string) {
  await page.goto("/");
  await page.getByRole("tab", { name: "Регистрация", exact: true }).click();
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').nth(0).fill(password);
  await page.locator('input[type="password"]').nth(1).fill(password);
  await page.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

async function login(page: Page, username: string) {
  await page.goto("/");
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

test("nickname editing validates, syncs sessions and preserves search, login and conversations", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses disposable local accounts");
  const first = await browser.newContext({ baseURL });
  const viewer = await browser.newContext({ baseURL });
  const secondDevice = await browser.newContext({ baseURL });
  const stamp = Date.now();
  const original = `nick${stamp}`;
  const renamed = `renamed${stamp}`;
  const viewerName = `find${stamp}`;
  const errors: string[] = [];
  try {
    for (const context of [first, viewer, secondDevice]) {
      await context.route("**/api/ringtones?page=*", route => route.fulfill({ json: { items: [], page: 1, pages: 1 } }));
      context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    }
    const owner = await first.newPage();
    const finder = await viewer.newPage();
    await register(owner, original);
    await register(finder, viewerName);

    // A stranger must be discoverable directly from the main conversation search.
    const search = finder.getByRole("textbox", { name: "Поиск диалогов", exact: true });
    await search.fill(`@${original.toUpperCase()}`);
    const person = finder.locator(".person-item").filter({ hasText: `@${original}` });
    await expect(person).toHaveCount(1);
    await person.click();
    const composer = finder.getByRole("textbox", { name: "Написать сообщение…" });
    await expect(composer).toBeVisible();
    await composer.fill(`Nickname search ${stamp}`);
    await composer.press("Enter");
    await expect(finder.locator(".room__messages")).toContainText(`Nickname search ${stamp}`);

    const otherSession = await secondDevice.newPage();
    await login(otherSession, original);
    await otherSession.getByRole("button", { name: "Открыть профиль", exact: true }).click();
    await owner.getByRole("button", { name: "Открыть профиль", exact: true }).click();
    const nickname = owner.getByRole("textbox", { name: "Никнейм", exact: true });
    await expect(nickname).toHaveValue(original);
    await nickname.fill(viewerName.toUpperCase());
    await owner.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(owner.getByRole("dialog", { name: "Профиль", exact: true }).getByRole("alert")).toHaveText("Этот никнейм уже занят");
    await expect(owner.locator(".profile__meta")).toContainText(`@${original}`);
    await nickname.fill("ab");
    await owner.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(owner.getByRole("dialog", { name: "Профиль", exact: true }).getByRole("alert")).toHaveText("Никнейм от 3 до 24 символов");
    await nickname.fill(`@${renamed}`);
    await expect(nickname).toHaveValue(renamed);
    await owner.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(owner.getByRole("dialog", { name: "Профиль", exact: true })).toHaveCount(0);
    await expect(otherSession.getByRole("textbox", { name: "Никнейм", exact: true })).toHaveValue(renamed);
    await owner.reload();
    await owner.getByRole("button", { name: "Открыть профиль", exact: true }).click();
    await expect(nickname).toHaveValue(renamed);
    await owner.screenshot({ path: testInfo.outputPath("nickname-profile.png") });

    await search.fill(`@${original}`);
    await expect(finder.locator(".person-item")).toHaveCount(0);
    await search.fill(`@${renamed.toUpperCase()}`);
    await expect(finder.locator(".person-item").filter({ hasText: `@${renamed}` })).toHaveCount(1);

    await finder.getByRole("navigation", { name: "Серверы и группы" }).getByRole("button", { name: "Люди", exact: true }).click();
    const peopleSearch = finder.getByRole("textbox", { name: "Поиск людей и групп" });
    await peopleSearch.fill("");
    await expect(finder.locator(".person-item")).toHaveCount(0);
    await expect(finder.getByText("Кому написать", { exact: true })).toHaveCount(0);
    await expect(finder.getByText("Введите @никнейм, чтобы найти человека.", { exact: true })).toBeVisible();
    await peopleSearch.fill(`@${original[0]}`);
    await expect(finder.locator(".person-item")).toHaveCount(0);
    await peopleSearch.fill("@nonexistent_nickname");
    await expect(finder.locator(".person-item")).toHaveCount(0);
    await peopleSearch.fill(`@${renamed.toUpperCase()}`);
    const foundPerson = finder.locator(".person-item").filter({ hasText: `@${renamed}` });
    await expect(foundPerson).toHaveCount(1);
    await finder.screenshot({ path: testInfo.outputPath("nickname-search.png") });
    await peopleSearch.fill("");
    await expect(finder.locator(".person-item")).toHaveCount(0);
    await peopleSearch.fill(`@${renamed}`);
    await expect(foundPerson).toHaveCount(1);
    await foundPerson.click();
    await expect(finder.locator(".room__messages")).toContainText(`Nickname search ${stamp}`);
    await owner.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(owner.locator(".workspace")).toHaveCount(0);
    await login(owner, renamed);
    await owner.getByRole("button", { name: "Открыть профиль", exact: true }).click();
    await expect(nickname).toHaveValue(renamed);
    await owner.setViewportSize({ width: 390, height: 844 });
    await expect(nickname).toBeVisible();
    await owner.screenshot({ path: testInfo.outputPath("nickname-profile-mobile.png") });
    expect(errors).toEqual([]);
  } finally {
    await first.close();
    await viewer.close();
    await secondDevice.close();
  }
});
