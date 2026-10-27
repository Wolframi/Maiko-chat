import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";

test.use({ channel: "msedge" });

let script: string;
let styles: string;
let video: Buffer;

// Mount the real bubble with the app's styles, without accounts or stored messages.
test.beforeAll(async () => {
  const root = process.cwd();
  script = (await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { MessageBubble } from "./src/components/chat/MessageBubble";
        window.showMedia = (files) => createRoot(document.getElementById("root")).render(
          <div className="bubble-group__body">
            <MessageBubble mine={files[0].mine ?? false} hideAvatarColumn showMeta={false} animate={false} message={{
              id: "media", room: "test", author: "Test", kind: "file", text: files[0].caption ?? "Подпись",
              createdAt: 1700000000000, file: files[0], files: files.length > 1 ? files : undefined,
            }} />
            <MessageBubble mine={false} hideAvatarColumn showMeta={false} animate={false} message={{
              id: "following", room: "test", author: "Test", text: "Следующее сообщение",
              createdAt: 1700000000001,
            }} />
          </div>
        );`,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
  })).outputFiles[0].text;
  const globals = await readFile(path.join(root, "src/app/globals.css"), "utf8");
  styles = (await Promise.all([...globals.matchAll(/@import "(\.\/styles\/[^"]+)"/g)]
    .map((match) => readFile(path.join(root, "src/app", match[1]), "utf8")))).join("\n");

  video = await readFile("e2e/fixtures/media-loading.webm");
});

const cases = [
  { name: "portrait photo", mime: "image/png", width: 900, height: 1600 },
  { name: "landscape photo", mime: "image/png", width: 1600, height: 900 },
  { name: "small photo", mime: "image/png", width: 96, height: 160 },
  { name: "GIF", mime: "image/gif", width: 900, height: 1600 },
  { name: "portrait video", mime: "video/webm", width: 96, height: 160 },
  { name: "outgoing photo without caption", mime: "image/png", width: 1600, height: 900, mine: true, caption: "" },
  { name: "outgoing video without caption", mime: "video/webm", width: 96, height: 160, mine: true, caption: "" },
  { name: "legacy photo", mime: "image/png" },
  { name: "legacy GIF", mime: "image/gif" },
  { name: "legacy video", mime: "video/webm" },
  { name: "legacy mixed album", mime: "image/png", album: true },
];

for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
  for (const item of cases) {
    test(`${item.name} keeps its geometry after loading at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route("http://media-layout.test/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/") {
          return route.fulfill({ contentType: "text/html", body: `
            <style>*,*::before,*::after{box-sizing:border-box}${styles}</style>
            <div id="root" style="width:100%;padding:12px"></div><script>${script}</script>` });
        }
        await gate;
        if (url.pathname.endsWith(".webm")) {
          return route.fulfill({ contentType: "video/webm", body: video });
        }
        return route.fulfill({ contentType: "image/svg+xml", body:
          '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="160"><rect width="96" height="160" fill="purple"/></svg>' });
      });
      try {
        await page.goto("http://media-layout.test/");
        await page.evaluate((item) => {
          const file = { ...item, url: item.mime.startsWith("video/") ? "/test.webm" : "/test.gif", size: 100 };
          (window as unknown as { showMedia: (files: unknown[]) => void }).showMedia(
            "album" in item ? [file, { ...file, url: "/test.webm", mime: "video/webm" }] : [file],
          );
        }, item);
        const bubble = page.locator("#msg-media .bubble");
        await expect(bubble).toBeVisible();
        const before = await bubble.boundingBox();
        const following = await page.locator("#msg-following").boundingBox();
        expect(before!.height).toBeGreaterThan(100);
        expect(before!.width).toBeLessThanOrEqual(viewport.width - 24);
        const frame = await page.locator("#msg-media .bubble__media-frame, #msg-media .bubble__album-grid").boundingBox();
        expect(before!.width).toBeCloseTo(frame!.width, 1);
        release();
        await expect.poll(() => page.locator("#msg-media img, #msg-media video").evaluateAll((elements) =>
          elements.map((element) => element instanceof HTMLVideoElement
            ? { loaded: element.videoWidth > 0, error: element.error?.message, src: element.getAttribute("src") }
            : { loaded: (element as HTMLImageElement).naturalWidth > 0, src: element.getAttribute("src") })
            .filter((state) => !state.loaded),
        )).toEqual([]);
        // Allow React load handlers and a subsequent layout/paint to settle.
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await bubble.boundingBox()).toEqual(before);
        expect(await page.locator("#msg-following").boundingBox()).toEqual(following);
        if (!("album" in item) && item.mime.startsWith("image/")) {
          await expect(page.locator("#msg-media img")).toHaveCSS("object-fit", "contain");
        }
        expect(errors).toEqual([]);
      } finally {
        release();
      }
    });
  }
}
