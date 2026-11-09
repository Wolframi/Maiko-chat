import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";

test.use({ channel: "msedge", viewport: { width: 1000, height: 800 } });
let html: string;
test.beforeAll(async () => {
  const script = (await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {MessageList} from './src/components/chat/MessageList';
      const own=new URLSearchParams(location.search).has('own');
      const media=new URLSearchParams(location.search).get('media');
      const messages=Array.from({length:100},(_,i)=>({id:'row-'+i,room:'test',
        authorId:i<60?(own?'self':'peer'):i%2?'peer':'other',author:i<60?(own?'Self':'Peer'):i%2?'Peer':'Other',
        kind:'text',text:'One line '+i,createdAt:1700000000000+i}));
      if(media){
        const message=messages[70];
        message.text='';
        message.authorId=own?'self':'other';
        message.kind=media==='sticker'?'sticker':'file';
        if(media==='sticker') message.sticker={packId:'pack',stickerId:'one',url:'/media.svg',width:300,height:300};
        else message.file={name:media==='gif'?'one.gif':'one.png',url:'/media.svg',mime:media==='gif'?'image/gif':'image/png',size:100,width:300,height:500};
      }
      createRoot(document.getElementById('root')).render(<MessageList chatId="test" messages={messages}
        account={{userId:'self',username:'self'}} people={[]} othersTyping={[]} showOwnAvatar={own}/>);
    ` }, bundle: true, write: false, jsx: "automatic", minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text;
  const globals = await readFile("src/app/globals.css", "utf8");
  const styles = (await Promise.all([...globals.matchAll(/@import "(\.\/styles\/[^"]+)"/g)]
    .map(match => readFile(path.join("src/app", match[1]), "utf8")))).join("\n");
  html = `<!doctype html><style>*,*::before,*::after{box-sizing:border-box}${styles}body{margin:0}#root{height:600px;display:flex;flex-direction:column}</style><div id="root"></div><script>${script}</script>`;
});

for (const [desktop,own] of [[false,false],[true,false],[true,true]] as const) {
  test(`single-line avatars stay attached to their row and streak avatars do not lag a frame (desktop=${desktop}, own=${own})`, async ({ page }) => {
    await page.route("http://avatar-motion.test/**", route => route.fulfill({contentType:"text/html",body:
      desktop && new URL(route.request().url()).pathname === "/"
        ? '<script>window.maikoMediaRuntime={version:1}</script><iframe src="/ui'+(own?'?own':'')+'" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>' : html}));
    await page.goto("http://avatar-motion.test/"+(own?'?own':''));
    const frame = desktop ? await (await page.locator("iframe").elementHandle())!.contentFrame() : page.mainFrame();
    const scroller = frame!.locator(".room__messages");
    await expect(frame!.locator("#msg-row-99")).toBeInViewport();
    await scroller.dispatchEvent("wheel", { deltaY: -100 });
    if (!desktop) {
      await scroller.evaluate(element => { element.scrollTop -= 1200; });
      await expect(frame!.locator("#msg-row-70")).toBeAttached();
    }
    const singles = await scroller.evaluate(async element => {
      const row = document.getElementById("msg-row-70")!;
      element.scrollTop += row.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom + 4;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const offsets: number[] = [];
      for (const movement of [0, 8, 8, 8, -8, -8, -8]) {
        element.scrollTop += movement;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const current = document.getElementById("msg-row-70")!;
        offsets.push(current.querySelector(".avatar")!.getBoundingClientRect().top-current.getBoundingClientRect().top);
      }
      return offsets;
    });
    expect(Math.max(...singles)-Math.min(...singles)).toBeLessThan(0.5);
    await scroller.evaluate(element => { element.scrollTop = 600; });
    await expect.poll(() => scroller.evaluate(element => [...element.querySelectorAll<HTMLElement>(".avatar")].filter(avatar => {
      const rect=avatar.getBoundingClientRect(), bounds=element.getBoundingClientRect();
      return getComputedStyle(avatar).visibility === "visible" && rect.bottom>bounds.top && rect.top<bounds.bottom;
    }).length)).toBe(1);
    const pinned = await scroller.evaluate(async element => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const errors: number[] = [];
      for (let i=0;i<16;i++) {
        element.scrollTop += i<8?6:-6;
        await new Promise(requestAnimationFrame);
        const avatar = [...element.querySelectorAll<HTMLElement>(".avatar")].find(avatar => getComputedStyle(avatar).visibility === "visible" && avatar.getBoundingClientRect().bottom>element.getBoundingClientRect().top)!;
        errors.push(Math.abs(avatar.getBoundingClientRect().bottom-(element.getBoundingClientRect().bottom-8)));
      }
      return errors;
    });
    expect(Math.max(...pinned)).toBeLessThan(0.5);
    if(own){
      await page.setViewportSize({width:375,height:800});
      await expect(frame!.locator('.message-avatar-group--mine .message-avatar-group__rail')).toBeHidden();
    }
  });
}

for (const [desktop, own, width] of [[false, false, 1000], [true, false, 1000], [false, false, 375], [true, false, 375], [false, true, 1000], [true, true, 1000]] as const) {
  for (const media of ["sticker", "photo", "gif"]) {
    test(`a lone ${media} keeps its avatar at the visible bottom (desktop=${desktop}, own=${own}, width=${width})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const query = `?media=${media}${own ? "&own" : ""}`;
      await page.route("http://avatar-motion.test/**", route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/media.svg") return route.fulfill({ contentType: "image/svg+xml", body:
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="purple"/></svg>' });
        return route.fulfill({ contentType: "text/html", body: desktop && pathname === "/"
          ? `<script>window.maikoMediaRuntime={version:1}</script><iframe src="/ui${query}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>` : html });
      });
      await page.goto(`http://avatar-motion.test/${query}`);
      const frame = desktop ? await (await page.locator("iframe").elementHandle())!.contentFrame() : page.mainFrame();
      const scroller = frame!.locator(".room__messages");
      const row = frame!.locator("#msg-row-70");
      await expect(frame!.locator("#msg-row-99")).toBeInViewport();
      await scroller.dispatchEvent("wheel", { deltaY: -100 });
      await expect.poll(() => scroller.evaluate(element => {
        const target = document.getElementById("msg-row-70");
        if (!target) { element.scrollTop -= 200; return false; }
        const distance = target.getBoundingClientRect().top - element.getBoundingClientRect().bottom + 100;
        element.scrollTop += distance;
        return Math.abs(distance) < 1;
      })).toBe(true);
      const avatar = desktop ? frame!.locator(".message-avatar-group:has(#msg-row-70) .message-avatar-group__sticky > .avatar") : row.locator(":scope > .avatar");
      await expect(avatar).toBeVisible();
      const pinnedBottom = async () => {
        const bounds = (await scroller.boundingBox())!;
        const photo = (await avatar.boundingBox())!;
        return Math.abs(photo.y + photo.height - (bounds.y + bounds.height - 8));
      };
      await expect.poll(pinnedBottom).toBeLessThan(1);
      for (const movement of [10, 10, -10, -10]) {
        await scroller.evaluate((element, delta) => { element.scrollTop += delta; }, movement);
        await expect.poll(pinnedBottom).toBeLessThan(1);
      }
      // Once the whole media row is visible, the avatar stops at its own bottom.
      await scroller.evaluate(element => {
        const rect = document.getElementById("msg-row-70")!.getBoundingClientRect();
        element.scrollTop += rect.bottom - element.getBoundingClientRect().bottom + 80;
      });
      await expect.poll(async () => {
        const photo = (await avatar.boundingBox())!;
        const message = (await row.boundingBox())!;
        return Math.abs(photo.y + photo.height - message.y - message.height);
      }).toBeLessThan(1);
      expect(errors).toEqual([]);
    });
  }
}
