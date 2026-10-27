import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function isolatedServer() {
  const helper = pathToFileURL(path.resolve("tests/helpers/securityServer.ts")).href;
  const script = `import { securityServer } from ${JSON.stringify(helper)};
    const server = await securityServer({registrationRequired:true});
    process.send({base:server.base,token:server.token});
    process.once('message',async()=>{await server.stop();process.exit();});
    process.once('disconnect',async()=>{await server.stop();process.exit();});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let logs = "";
  child.stderr?.on("data", data => { logs += data; });
  const result = await new Promise<{base:string;token:string}>((resolve,reject) => {
    child.once("message", message => resolve(message as {base:string;token:string}));
    child.once("exit", code => reject(new Error(`Fixture exited ${code}: ${logs}`)));
  });
  return { ...result, stop: async () => { child.send("stop"); await new Promise(resolve => child.once("exit",resolve)); } };
}

test.use({ channel: "msedge" });

test("every new member gets an invitation; only the owner controls the registration gate", async ({ browser }, testInfo) => {
  test.setTimeout(180000);
  const server = await isolatedServer();
  const adminContext = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], reducedMotion: "reduce" });
  const guestContext = await browser.newContext({ reducedMotion: "reduce" });
  const errors: string[] = [];
  try {
    await adminContext.addInitScript(token => localStorage.setItem("pulse-chat-token", token), server.token);
    const admin = await adminContext.newPage(), guest = await guestContext.newPage();
    admin.on("pageerror", error => errors.push(error.message));
    guest.on("pageerror", error => errors.push(error.message));
    await admin.goto(server.base);
    await admin.getByRole("button", { name: "Профиль", exact: true }).click();
    await admin.getByRole("tab", { name: "Приглашения", exact: true }).click();
    await expect(admin.locator(".registration-invites__hint").first()).toContainText("раз в неделю");
    const toggle = admin.getByRole("switch", { name: "Регистрация по приглашениям" });
    await expect(toggle).toBeChecked();
    await admin.getByRole("button", { name: "Скопировать приглашение в Майко" }).click();
    await expect(admin.getByRole("status")).toContainText("Код скопирован");
    const code = await admin.evaluate(() => navigator.clipboard.readText());
    expect(code).toMatch(/^[A-F0-9]{4}(-[A-F0-9]{4}){4}$/);
    await guest.goto(server.base);
    await guest.getByRole("tab", { name: "Регистрация", exact: true }).click();
    const input = guest.getByPlaceholder("XXXX-XXXX-XXXX-XXXX-XXXX");
    await expect(input).toBeVisible();
    await expect(guest.locator("#registration-invite-hint")).toContainText("раз в неделю");
    await toggle.click();
    await expect(input).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(input).toBeVisible();
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({ path: testInfo.outputPath("registration-mobile.png"), fullPage: true });
    await guest.getByPlaceholder("artem").fill("invited-member");
    await guest.locator('input[type="password"]').nth(0).fill("NewGuest123!");
    await guest.locator('input[type="password"]').nth(1).fill("NewGuest123!");
    await input.fill(code.toLowerCase());
    await guest.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
    await guest.getByRole("button", { name: "Профиль", exact: true }).click();
    await guest.getByRole("tab", { name: "Приглашения", exact: true }).click();
    const memberCode = guest.getByRole("textbox", { name: "Ваш код приглашения", exact: true });
    await expect(memberCode).not.toHaveValue("");
    await expect(guest.locator(".registration-invites__hint")).toContainText(/До обновления: \d д/);
    expect(await memberCode.inputValue()).not.toBe(code);
    const savedCode = await memberCode.inputValue();
    await expect(guest.getByRole("switch")).toHaveCount(0);
    await guest.screenshot({ path: testInfo.outputPath("member-mobile.png") });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await guest.reload();
    await guest.getByRole("button", { name: "Профиль", exact: true }).click();
    await guest.getByRole("tab", { name: "Приглашения", exact: true }).click();
    await expect(guest.getByRole("textbox", { name: "Ваш код приглашения", exact: true })).toHaveValue(savedCode);
    expect(errors).toEqual([]);
  } finally { await adminContext.close(); await guestContext.close(); await server.stop(); }
});
