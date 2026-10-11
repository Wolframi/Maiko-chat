import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "msedge", permissions: ["camera", "microphone"], launchOptions: {
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
} });

async function login(page: Page, username: string, password: string) {
  await page.goto("/");
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

test("two local peers keep camera video while toggling mic and headphones", async ({ browser, baseURL }) => {
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses local demo accounts only");
  const a = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  const b = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  try {
    const caller = await a.newPage();
    const receiver = await b.newPage();
    await login(caller, "artem", "Artem1234!");
    await login(receiver, "alice", "Alice1234!");
    await caller.getByRole("button", { name: /^Алиса/ }).click();
    await caller.getByRole("button", { name: "Звонок", exact: true }).click();
    await receiver.getByRole("button", { name: "Ответить", exact: true }).click();
    await caller.getByRole("button", { name: "Включить камеру", exact: true }).click();
    await receiver.getByRole("button", { name: "Включить камеру", exact: true }).click();
    await expect.poll(() => caller.locator("video").evaluateAll((nodes) => nodes.filter((node) => (node as HTMLVideoElement).videoWidth > 0).length)).toBeGreaterThanOrEqual(2);
    await expect(caller.locator(".connection-signal--good, .connection-signal--ok, .connection-signal--poor").first()).toBeVisible();
    await caller.evaluate(() => {
      const state = [...document.querySelectorAll("video")].filter((video) => video.videoWidth > 0).map((video) => {
        const item = { video, stream: video.srcObject, resets: 0 };
        video.addEventListener("emptied", () => item.resets++);
        return item;
      });
      Object.assign(window, { __callVideoState: state });
    });
    for (let i = 0; i < 3; i++) {
      await caller.getByRole("button", { name: /^(Включить|Выключить) микрофон$/ }).click();
      await caller.getByRole("button", { name: /^(Включить|Отключить) звук$/ }).click();
    }
    const state = await caller.evaluate(() => {
      const items = (window as unknown as { __callVideoState: { video: HTMLVideoElement; stream: unknown; resets: number }[] }).__callVideoState;
      return { stable: items.every((v) => v.video.isConnected && v.video.srcObject === v.stream), resets: items.reduce((n, v) => n + v.resets, 0) };
    });
    expect(state).toEqual({ stable: true, resets: 0 });
    await caller.getByRole("button", { name: "Завершить звонок", exact: true }).click();
  } finally { await a.close(); await b.close(); }
});
