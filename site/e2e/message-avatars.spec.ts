import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

test.use({ channel: "msedge" });
let html: string;
test.beforeAll(async () => {
  const script = (await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { MessageList } from './src/components/chat/MessageList';
      const messages = Array.from({length: 100}, (_, i) => ({
        id: 'row-' + i, room: 'test', authorId: i < 50 ? 'peer' : 'self',
        author: i < 50 ? 'Peer' : 'Self', kind: 'text',
        createdAt: 1700000000000 + i, text: 'Message ' + i + ': ' + 'Variable height text. '.repeat(i % 5 + 1)
      }));
      createRoot(document.getElementById('root')).render(<MessageList chatId="test"
        account={{userId:'self',username:'self',displayName:'Self'}} people={[]} othersTyping={[]}
        showOwnAvatar={new URLSearchParams(location.search).has('own')} messages={messages} />);
    ` },
    bundle: true, write: false, jsx: "automatic", minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text;
  const globals = await readFile("src/app/globals.css", "utf8");
  const styles = (await Promise.all([...globals.matchAll(/@import "(\.\/styles\/[^"]+)"/g)]
    .map(match => readFile(path.join("src/app", match[1]), "utf8")))).join("\n");
  html = `<!doctype html><style>*,*::before,*::after{box-sizing:border-box}${styles}
    body{margin:0}#root{height:600px;display:flex;flex-direction:column}</style><div id="root"></div><script>${script}</script>`;
  await mkdir("tmp", { recursive: true });
  await writeFile("tmp/message-avatars.html", html);
});

for (const own of [false, true]) {
test(`avatars follow a virtualized streak and stay inside its boundaries (own=${own})`, async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://message-avatars.test/**", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`http://message-avatars.test/${own ? '?own' : ''}`);
  const scroller = page.locator(".room__messages");
  await expect(page.locator("#msg-row-99")).toBeInViewport();
  await scroller.dispatchEvent("wheel", { deltaY: -800 });
  await scroller.evaluate(element => { element.scrollTop = 600; });
  const avatar = page.locator(".bubble-row > .avatar:visible");
  await expect(avatar).toHaveCount(1);
  await expect(page.locator("#msg-row-49")).toHaveCount(0);
  const bottom = (await scroller.boundingBox())!.y + (await scroller.boundingBox())!.height - 8;
  await expect.poll(async () => { const box = (await avatar.boundingBox())!; return Math.abs(box.y + box.height - bottom); }).toBeLessThan(1);
  await scroller.evaluate(element => { element.scrollTop += 200; });
  await expect.poll(async () => { const box = (await avatar.boundingBox())!; return Math.abs(box.y + box.height - bottom); }).toBeLessThan(1);
  // Reveal the author boundary: the first avatar must stop on its own last row.
  for (let i = 0; i < 15 && !await page.locator("#msg-row-49").count(); i++) {
    await scroller.evaluate(element => { element.scrollTop += 180; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await expect(page.locator("#msg-row-49")).toBeAttached();
  await scroller.evaluate(element => {
    const row = document.getElementById("msg-row-49")!;
    element.scrollTop += row.getBoundingClientRect().bottom - element.getBoundingClientRect().top - 250;
  });
  const peer = page.locator("#msg-row-49 > .avatar");
  await expect(peer).toBeVisible();
  await expect.poll(async () => {
    const photo = (await peer.boundingBox())!;
    const row = (await page.locator("#msg-row-49").boundingBox())!;
    return Math.abs(photo.y + photo.height - row.y - row.height);
  }).toBeLessThan(1);
  const incoming = (await page.locator("#msg-row-49 .bubble").boundingBox())!;
  const outgoing = (await page.locator("#msg-row-50 .bubble").boundingBox())!;
  expect(outgoing.x).toBeCloseTo(incoming.x, 1);
  await page.screenshot({ path: `tmp/message-avatars-desktop-${own}.png` });
  await page.setViewportSize({ width: 375, height: 800 });
  if (!own) {
    const row = (await page.locator("#msg-row-50").boundingBox())!;
    const bubble = (await page.locator("#msg-row-50 .bubble").boundingBox())!;
    expect(bubble.x + bubble.width).toBeCloseTo(row.x + row.width - 2, 1);
  }
  await expect(avatar).toHaveCount(1);
  await page.screenshot({ path: `tmp/message-avatars-mobile-${own}.png` });
  expect(errors).toEqual([]);
});
}
