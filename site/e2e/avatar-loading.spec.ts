import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

test.use({ channel: "msedge" });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let bundle: string;

test.beforeAll(async () => {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { Avatar } from "./src/components/chat/Avatar";
        const root = createRoot(document.getElementById("root"));
        window.updateAvatar = (src, speaking = false) => flushSync(() => root.render(
          <React.StrictMode>
            <div className={speaking ? "is-speaking" : ""}>
              <Avatar name="Avatar Test" src={src} size="xl" />
            </div>
          </React.StrictMode>
        ));
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    tsconfig: path.resolve("tsconfig.json"),
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route("**/__avatar_test", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><body><div id="root"></div></body></html>',
  }));
  await page.goto("http://127.0.0.1:3000/__avatar_test");
  await page.addScriptTag({ content: bundle });
});

type AvatarWindow = Window & {
  updateAvatar: (src: string | null, speaking?: boolean) => void;
  originalImage?: HTMLImageElement | null;
};

test("speaking and renewed signatures keep the loaded photo; a new photo replaces it", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/uploads/**", route => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: "image/png", body: png });
  });
  const initial = "/uploads/avatar.png?exp=1&sig=original";
  await page.evaluate(src => (window as unknown as AvatarWindow).updateAvatar(src), initial);
  await expect(page.locator(".avatar img.is-loaded")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as AvatarWindow).originalImage = document.querySelector(".avatar img");
  });
  for (let index = 0; index < 20; index++) {
    await page.evaluate(index => {
      (window as unknown as AvatarWindow).updateAvatar(`/uploads/avatar.png?exp=${index + 2}&sig=renewed${index}`, index % 2 === 0);
    }, index);
  }
  expect(requests).toHaveLength(1);
  await expect(page.locator(".avatar img")).toHaveAttribute("src", initial);
  expect(await page.evaluate(() => document.querySelector(".avatar img") === (window as unknown as AvatarWindow).originalImage)).toBe(true);
  await expect(page.locator(".avatar__fallback")).toHaveCount(0);

  await page.evaluate(() => (window as unknown as AvatarWindow).updateAvatar("/uploads/new-photo.png?exp=99&sig=new"));
  await expect(page.locator(".avatar img.is-loaded")).toHaveAttribute("src", "/uploads/new-photo.png?exp=99&sig=new");
  expect(requests).toHaveLength(2);
  await page.evaluate(() => (window as unknown as AvatarWindow).updateAvatar(null));
  await expect(page.locator(".avatar img")).toHaveCount(0);
  await expect(page.locator(".avatar")).toHaveText("AT");
});

test("speaking updates do not postpone a failed photo's retry", async ({ page }) => {
  await page.clock.install();
  const requests: string[] = [];
  await page.route("**/uploads/**", route => {
    requests.push(route.request().url());
    return route.request().url().includes("retry=1")
      ? route.fulfill({ contentType: "image/png", body: png })
      : route.fulfill({ status: 503, body: "Temporarily unavailable" });
  });
  const src = "/uploads/retry.png?exp=1&sig=original";
  await page.evaluate(src => (window as unknown as AvatarWindow).updateAvatar(src), src);
  await expect.poll(() => requests.length).toBe(1);
  // Wait for the failed request's browser event to schedule its retry.
  await page.waitForFunction(() => (document.querySelector(".avatar img") as HTMLImageElement)?.complete);
  for (let index = 0; index < 5; index++) {
    await page.evaluate(({ src, index }) => (window as unknown as AvatarWindow).updateAvatar(src, index % 2 === 0), { src, index });
    await page.clock.runFor(50);
  }
  expect(requests).toHaveLength(1);
  await page.clock.runFor(100);
  await expect(page.locator(".avatar img.is-loaded")).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("exp=1&sig=original&retry=1");
});

test("a failed photo uses renewed credentials and cancels its old retry", async ({ page }) => {
  await page.clock.install();
  const requests: string[] = [];
  await page.route("**/uploads/**", route => {
    requests.push(route.request().url());
    return route.request().url().includes("sig=renewed")
      ? route.fulfill({ contentType: "image/png", body: png })
      : route.fulfill({ status: 403, body: "Expired" });
  });
  await page.evaluate(() => (window as unknown as AvatarWindow).updateAvatar("/uploads/avatar.png?exp=1&sig=expired"));
  await page.waitForFunction(() => (document.querySelector(".avatar img") as HTMLImageElement)?.complete);
  await page.evaluate(() => (window as unknown as AvatarWindow).updateAvatar("/uploads/avatar.png?exp=2&sig=renewed", true));
  await expect(page.locator(".avatar img.is-loaded")).toBeVisible();
  await page.clock.runFor(3000);
  expect(requests).toHaveLength(2);
  await expect(page.locator(".avatar img")).toHaveAttribute("src", "/uploads/avatar.png?exp=2&sig=renewed");
});
