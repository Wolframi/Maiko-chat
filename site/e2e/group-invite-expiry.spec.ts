import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge" });
let bundle: string;
type InviteWindow = Window & { codeRequests?: number; copies?: string[]; failRefresh?: boolean; expired?: boolean };

test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {Toaster} from 'sonner';
        import {GroupInviteButton} from './src/components/chat/GroupInvitePanel';
        window.codeRequests=0;
        window.copies=[];
        Object.defineProperty(navigator,'clipboard',{value:{writeText:async code=>window.copies.push(code)},configurable:true});
        const getCode=async()=>{
          const count=++window.codeRequests;
          if(window.failRefresh&&count===2)return {ok:false,error:'Нет соединения'};
          const now=Date.now();
          return {ok:true,invite:{code:count===1?'ABCD-EFGH-JKLM':'NPQR-STUV-WXYZ',serverTime:now,expiresAt:now+(window.expired?0:604800000)}};
        };
        createRoot(document.getElementById('root')).render(<><GroupInviteButton groupId="private-fixture" onGetCode={getCode}/><Toaster/></>);
      `,
      loader: "tsx", resolveDir: process.cwd(),
    },
    bundle: true, write: false, tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.route("**/__invite_expiry", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div></body></html>' }));
  await page.goto("http://127.0.0.1:3000/__invite_expiry");
  await page.addScriptTag({ content: bundle });
});

test("each copy requests the current code without displaying it", async ({ page }) => {
  const button = page.getByRole("button", { name: "Скопировать код приглашения", exact: true });
  expect(await page.evaluate(() => (window as InviteWindow).codeRequests)).toBe(0);
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as InviteWindow).copies)).toEqual(["ABCD-EFGH-JKLM"]);
  await page.clock.runFor(604800001);
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as InviteWindow).copies)).toEqual(["ABCD-EFGH-JKLM", "NPQR-STUV-WXYZ"]);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("ABCD-EFGH-JKLM");
  await expect(page.locator("body")).not.toContainText("NPQR-STUV-WXYZ");
});

test("failed requests never copy a cached code and can be retried", async ({ page }) => {
  const button = page.getByRole("button", { name: "Скопировать код приглашения", exact: true });
  await button.click();
  await page.evaluate(() => { (window as InviteWindow).failRefresh = true; });
  await button.click();
  await expect(page.getByText("Нет соединения", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as InviteWindow).copies)).toEqual(["ABCD-EFGH-JKLM"]);
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as InviteWindow).copies)).toEqual(["ABCD-EFGH-JKLM", "NPQR-STUV-WXYZ"]);
});

test("a code that expired during the request is not copied", async ({ page }) => {
  await page.evaluate(() => { (window as InviteWindow).expired = true; });
  await page.getByRole("button", { name: "Скопировать код приглашения", exact: true }).click();
  await expect(page.getByText("Код обновился. Нажмите ещё раз", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as InviteWindow).copies)).toEqual([]);
});
