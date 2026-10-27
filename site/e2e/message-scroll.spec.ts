import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";

declare global {
  interface Window {
    scrollTest: { older: number; newer: number; newerAnchor?: { id: string; top: number }; release(): void; search(): void; clearSearch(): void };
  }
}

test.use({ channel: "msedge", viewport: { width: 1000, height: 800 } });

for (const reducedMotion of ["no-preference", "reduce"] as const) {
test.describe(reducedMotion, () => {
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion }); });
for (const clustered of [false, true]) {
test(`scrolling during a delayed prepend preserves every painted position and newer pages load without buttons (${clustered ? "clustered" : "mixed"})`, async ({ page }) => {
  test.setTimeout(240_000);
  const script = (await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { MessageList } from './src/components/chat/MessageList';
      const account = { userId: 'self', username: 'self', displayName: 'Self' };
      const people = [], typing = [];
      const rows = (start, end) => Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return { id: 'row-' + index, room: 'test', authorId: ${clustered} ? 'self' : index % 2 ? 'peer' : 'self',
          author: ${clustered} ? 'Self' : index % 2 ? 'Peer' : 'Self', kind: 'text', createdAt: 1700000000000 + index,
          text: ${clustered} ? 'History message ' + index : index + ': ' + 'Message with variable height. '.repeat(index % 7 + 1) };
      });
      let release;
      window.scrollTest = { older: 0, newer: 0, release: () => release() };
      function App() {
        const [messages, setMessages] = useState(rows(200, 280));
        const [hasMore, setHasMore] = useState(true);
        const [hasNewer, setHasNewer] = useState(false);
        const [loading, setLoading] = useState(false);
        const [version, setVersion] = useState(0);
        const [target, setTarget] = useState(null);
        window.scrollTest.search = () => {
          setMessages(rows(200, 280)); setHasMore(false); setHasNewer(true);
          setVersion(value => value + 1); setTarget('row-240');
        };
        window.scrollTest.clearSearch = () => setTarget(null);
        return <MessageList chatId="test" account={account} people={people} othersTyping={typing}
          messages={messages} historyVersion={version} hasMore={hasMore} hasNewer={hasNewer}
          loadingOlder={loading} activeMatchId={target} searchQuery={target ? '240' : ''}
          onLoadOlder={async () => {
            window.scrollTest.older++; setLoading(true);
            await new Promise(resolve => { release = resolve; });
            flushSync(() => { setMessages(current => [...rows(120, 200), ...current]); setLoading(false); });
            return true;
          }}
          onLoadNewer={async () => {
            window.scrollTest.newer++; setLoading(true);
            await new Promise(resolve => setTimeout(resolve, 150));
            const scroller = document.querySelector('.room__messages');
            const bounds = scroller.getBoundingClientRect();
            const anchor = Array.from(scroller.querySelectorAll('[id^="msg-"]')).find(row => row.getBoundingClientRect().bottom > bounds.top);
            window.scrollTest.newerAnchor = { id: anchor.id, top: anchor.getBoundingClientRect().top };
            setMessages(current => [...current, ...rows(280, 360)]); setHasNewer(false); setLoading(false);
            return true;
          }} />;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` },
    bundle: true, write: false, jsx: "automatic", minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text;
  const globals = await readFile("src/app/globals.css", "utf8");
  const styles = (await Promise.all([...globals.matchAll(/@import "(\.\/styles\/[^"]+)"/g)]
    .map(match => readFile(path.join("src/app", match[1]), "utf8")))).join("\n");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://message-scroll.test/", route => route.fulfill({ contentType: "text/html", body: `
    <style>${styles}#root{height:600px;display:flex;flex-direction:column}</style><div id="root"></div><script>${script}</script>` }));
  await page.goto("http://message-scroll.test/");
  const thread = page.locator(".room__messages-wrap");
  const scroller = page.locator(".room__messages");
  await expect(page.locator("#msg-row-279")).toBeInViewport();
  await scroller.dispatchEvent("wheel", { deltaY: -800 });
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => page.evaluate(() => window.scrollTest.older)).toBe(1);
  // Input during the request used to cancel the saved anchor entirely.
  await scroller.dispatchEvent("wheel", { deltaY: 80 });
  await scroller.evaluate((element, top) => { element.scrollTop = top; }, clustered ? 0 : 80);
  const frames = await scroller.evaluate(async element => {
    await new Promise(requestAnimationFrame);
    const bounds = element.getBoundingClientRect();
    const anchor = Array.from(element.querySelectorAll<HTMLElement>("[id^='msg-']"))
      .find(row => row.getBoundingClientRect().bottom > bounds.top)!;
    const id = anchor.id;
    const positions = [anchor.getBoundingClientRect().top];
    window.scrollTest.release();
    for (let frame = 0; frame < 24; frame++) {
      await new Promise(requestAnimationFrame);
      const row = document.getElementById(id);
      positions.push(row ? row.getBoundingClientRect().top : -10000);
    }
    return positions;
  });
  await expect(thread).toHaveAttribute("data-loaded-messages", "160");
  console.log(JSON.stringify({ maximumPrependShift: Math.max(...frames) - Math.min(...frames) }));
  expect(Math.max(...frames) - Math.min(...frames)).toBeLessThan(6);
  expect(await page.evaluate(() => window.scrollTest.older)).toBe(1);
  expect(await page.locator(".message-block").count()).toBeLessThan(80);
  const momentum = await scroller.evaluate(async element => {
    const before = element.scrollTop;
    element.scrollTop += 120;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return element.scrollTop - before;
  });
  expect(momentum).toBeGreaterThan(100);
  await page.evaluate(() => window.scrollTest.search());
  await expect(page.locator("#msg-row-240")).toBeInViewport();
  await page.evaluate(() => window.scrollTest.clearSearch());
  await expect(page.getByRole("button", { name: "Следующие сообщения", exact: true })).toHaveCount(0);
  await scroller.dispatchEvent("wheel", { deltaY: 800 });
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(thread).toHaveAttribute("data-loaded-messages", "160");
  await expect.poll(() => page.evaluate(() => {
    const anchor = window.scrollTest.newerAnchor!;
    const row = document.getElementById(anchor.id);
    return row ? Math.abs(row.getBoundingClientRect().top - anchor.top) : 10000;
  })).toBeLessThan(6);
  expect(await page.evaluate(() => window.scrollTest.newer)).toBe(1);
  expect(errors).toEqual([]);
});
}
});
}
