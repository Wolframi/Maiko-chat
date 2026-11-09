import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

test.use({ channel: "msedge" });
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: "reduce" }); });
let html: string;
const images = new Map<string, Buffer>();

test.beforeAll(async () => {
  const script = (await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { MessageBubble } from './src/components/chat/MessageBubble';
      import { StickerPicker } from './src/components/chat/StickerPicker';
      import { StickerPackViewer } from './src/components/chat/StickerPackViewer';
      const root = createRoot(document.getElementById('root'));
      window.selected = '';
      window.showSticker = (surface, url) => {
        const pack = { id: 'pack', title: 'Test pack', createdBy: 'self', createdAt: 1, updatedAt: 1,
          installed: true, canEdit: false, stickerCount: 1,
          stickers: [{ id: 'sticker', url, name: 'Static sticker', size: 200, addedAt: 1, width: 96, height: 160 }] };
        const send = (packId, stickerId) => { window.selected = packId + ':' + stickerId; };
        const yes = async () => true;
        flushSync(() => root.render(surface === 'chat'
          ? <MessageBubble mine={false} hideAvatarColumn animate={false} onOpenStickerPack={send}
              message={{ id: 'static', room: 'test', author: 'Peer', createdAt: 1700000000000,
                kind: 'sticker', text: '', sticker: { packId: 'pack', stickerId: 'sticker', url, width: 96, height: 160 } }} />
          : surface === 'picker'
            ? <StickerPicker open packs={[pack]} refreshPacks={async () => [pack]} onClose={() => {}} onSend={send}
                onCreatePack={async () => ({ok: true, pack})} onDeletePack={yes} onRenamePack={yes}
                onAddSticker={async () => ({ok: true})} onRemoveSticker={yes} />
            : <StickerPackViewer open packId="pack" fetchPack={async () => pack} onSend={send}
                onInstall={yes} onUninstall={yes} onClose={() => {}} />));
      };`,
    }, bundle: true, write: false, jsx: "automatic", minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text;
  const globals = await readFile("src/app/globals.css", "utf8");
  const styles = (await Promise.all([...globals.matchAll(/@import "(\.\/styles\/[^"]+)"/g)]
    .map(match => readFile(path.join("src/app", match[1]), "utf8")))).join("\n");
  html = `<style>*,*::before,*::after{box-sizing:border-box}${styles}#root{width:440px}</style><div id="root"></div><script>${script}</script>`;
  for (const format of ["png", "webp"]) images.set(format, await sharp({ create: {
    width: 96, height: 160, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.25 },
  } }).toFormat(format as "png" | "webp").toBuffer());
});

for (const surface of ["chat", "picker", "pack"]) {
  for (const format of ["png", "webp"]) {
    test(`${format} static sticker keeps alpha, size and its action in ${surface}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const requests: string[] = [];
      await page.route("http://static-stickers.test/", route => route.fulfill({ contentType: "text/html", body: html }));
      await page.route("**/uploads/**", async route => {
        requests.push(route.request().url());
        await gate;
        await route.fulfill({ contentType: `image/${format}`, body: images.get(format)! });
      });
      await page.goto("http://static-stickers.test/");
      try {
        await page.evaluate(({ surface, format }) => {
          (window as unknown as { showSticker(surface: string, url: string): void }).showSticker(surface, `/uploads/static.${format}?exp=1&sig=old`);
        }, { surface, format });
        const button = page.locator(surface === "chat" ? ".sticker-bubble" : surface === "picker"
          ? ".sticker-picker__item-send" : '[data-sticker-id="sticker"]');
        await expect(button).toBeVisible();
        // Finish the panel's entrance animation while the image is still held.
        await button.click({ trial: true });
        const before = await button.boundingBox();
        await expect(button.locator(".media-loading__sticker")).toBeVisible();
        await expect(button.locator(".media-loading__ring")).toBeVisible();
        if (surface === "chat" && format === "png") await button.screenshot({ path: "tmp/static-sticker-loading.png" });
        release();
        const image = button.locator("img");
        await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(96);
        const alpha = await image.evaluate(node => {
          const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 160;
          const context = canvas.getContext("2d")!;
          context.drawImage(node as HTMLImageElement, 0, 0);
          return context.getImageData(48, 80, 1, 1).data[3];
        });
        expect(alpha).toBeGreaterThan(60); expect(alpha).toBeLessThan(68);
        const after = await button.boundingBox();
        for (const dimension of ["width", "height"] as const) expect(after![dimension]).toBeCloseTo(before![dimension], 1);
        await expect(image).toHaveCSS("object-fit", "contain");
        await expect(button.locator(".media-micro-preview")).toHaveCount(0);
        await expect(button.locator(".media-loading")).toHaveCount(0);
        await button.click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { selected: string }).selected)).toBe("pack:sticker");
        expect(requests.length).toBeGreaterThan(0);
        expect(errors).toEqual([]);
      } finally { release(); }
    });
  }
}
