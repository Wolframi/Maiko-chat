import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge" });

test("layout commits preserve ongoing scroll movement in both directions instead of returning to an old anchor", async ({ page }) => {
  const script = (await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { ScrollAnchoredList } from './src/components/chat/ScrollAnchoredList';
      const context = { preserveScroll: true, anchorKey: 'page', scrollRevision: { current: 1 } };
      function App() {
        const [padding, setPadding] = useState(0);
        window.measureRows = value => flushSync(() => setPadding(value));
        return <div className="room__messages" style={{height: 320, overflow: 'auto', overflowAnchor: 'none'}}>
          <ScrollAnchoredList context={{...context, anchorKey: padding ? 'prepended-page' : 'page'}} style={{paddingTop: padding}}>
            {Array.from({length: 100}, (_, i) => <div id={'msg-' + i} key={i} style={{height: 40}}>Message {i}</div>)}
          </ScrollAnchoredList>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` },
    bundle: true, write: false, jsx: "automatic", minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text;
  await page.route("http://scroll-anchor.test/", route => route.fulfill({ contentType: "text/html",
    body: `<div id="root"></div><script>${script}</script>` }));
  await page.goto("http://scroll-anchor.test/");
  const errors = await page.locator(".room__messages").evaluate(async scroller => {
    const measure = (window as unknown as { measureRows(value: number): void }).measureRows;
    scroller.scrollTop = 800;
    measure(1); // The prepend's first commit establishes its anchor.
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const errors: number[] = [];
    for (const [index, movement] of [35, 40, -25, -30, 50, -50].entries()) {
      const anchor = document.getElementById("msg-24")!;
      const before = anchor.getBoundingClientRect().top;
      // Momentum changes the offset without another wheel/touch input event.
      scroller.scrollTop += movement;
      measure(20 + index * 17);
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      errors.push(Math.abs(anchor.getBoundingClientRect().top - (before - movement)));
    }
    return errors;
  });
  expect(Math.max(...errors)).toBeLessThan(1);
});
