import { expect, test } from "@playwright/test";
import { appServer } from "./helpers/appServer";

test.use({ channel: "msedge", launchOptions: {
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
} });

test("isolated runtimes keep direct calls and messages connected", async ({ browser }) => {
  test.setTimeout(180_000);
  const server = await appServer();
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL: server.base,
    permissions: ["microphone", "camera"], reducedMotion: "reduce", viewport: { width: 1280, height: 900 } })));
  const errors: string[] = [];
  let stage = "login";
  try {
    for (const context of contexts) {
      context.setDefaultTimeout(15_000);
      await context.addInitScript(() => {
        localStorage.setItem("pulse-krisp", "0");
        localStorage.setItem("pulse-browser-ns", "0");
        const NativePc = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePc {
          constructor(config?: RTCConfiguration) { super({ ...config, iceServers: [] }); }
        };
      });
      await context.route("**/api/ice", route => route.fulfill({ json: { iceServers: [] } }));
    }
    await contexts[0].addInitScript(token => localStorage.setItem("pulse-chat-token", token), server.token);
    const [caller, receiver] = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of [caller, receiver]) page.on("pageerror", error => errors.push(error.message));
    await Promise.all([caller.goto("/"), receiver.goto("/")]);
    await receiver.getByPlaceholder("artem").fill("seeduser1");
    await receiver.locator('input[type="password"]').fill("SecurityFixture123!");
    await receiver.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(receiver.locator(".workspace")).toBeVisible();
    await caller.getByRole("button", { name: "Люди", exact: true }).click();
    await caller.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@seeduser1");
    await caller.getByRole("button", { name: /Seed User 1\s+@seeduser1/ }).click();
    await caller.getByRole("button", { name: "Звонок", exact: true }).click();
    stage = "accept";
    await receiver.getByRole("button", { name: "Ответить", exact: true }).click();
    await expect(caller.locator(".call__status")).toHaveText(/\d+:\d{2}/);
    await expect(receiver.locator(".header-call em")).toHaveText(/\d+:\d{2}/);
    stage = "expand receiver";
    await receiver.getByRole("button", { name: "Вернуться к звонку с Seed User 0", exact: true }).click();
    await expect(receiver.locator(".call__status")).toHaveText(/\d+:\d{2}/);
    stage = "minimize caller";
    await caller.getByRole("button", { name: "Свернуть", exact: true }).click();
    const chip = caller.locator(".header-call");
    await expect(chip).toBeVisible();
    await chip.getByRole("button", { name: "Выключить микрофон", exact: true }).click();
    await expect(chip.getByRole("button", { name: "Включить микрофон", exact: true })).toBeVisible();
    stage = "message";
    const composer = caller.getByRole("textbox", { name: "Написать сообщение…" });
    await composer.fill("Message during call");
    await composer.press("Enter");
    await expect(caller.locator(".room__messages").getByText("Message during call")).toBeVisible();
    await expect(receiver.locator(".room__messages").getByText("Message during call")).toBeVisible();
    stage = "end";
    await chip.getByRole("button", { name: "Завершить звонок", exact: true }).click();
    await expect(chip).toHaveCount(0);
    await expect(receiver.locator(".call__card")).toHaveCount(0);
    await expect(caller.locator(".room__messages").getByText("Message during call")).toBeVisible();
    expect(errors).toEqual([]);
    stage = "complete";
  } catch (error) {
    console.log(JSON.stringify({ stage, errors }));
    throw error;
  } finally {
    await server.stop();
    await Promise.all(contexts.map(context => context.close()));
  }
});
