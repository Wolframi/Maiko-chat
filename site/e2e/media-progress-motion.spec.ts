import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

test.use({ channel: "msedge" });

let html: string;
test.beforeAll(async () => {
  const script = (await build({
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {MediaLoadingIndicator} from './src/components/chat/MediaLoadingIndicator';
      import {MessageBubble} from './src/components/chat/MessageBubble';
      const root = createRoot(document.getElementById('root'));
      const mode = new URLSearchParams(location.search).get('mode');
      window.setProgress = received => flushSync(() => root.render(
        mode === 'upload' ? <MessageBubble mine hideAvatarColumn animate={false} message={{
          id:'upload',room:'test',author:'Self',kind:'file',text:'',createdAt:1700000000000,
          status:'pending',uploadProgress:received/1000,
          file:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            name:'photo.png',mime:'image/png',size:1000,width:160,height:160}
        }}/> : <MediaLoadingIndicator sticker={mode === 'sticker'} progress={{received,total:1000}}/>
      ));
      window.setProgress(0);
    ` },
    bundle: true, write: false, jsx: "automatic", minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text;
  const styles = (await Promise.all(["media-loading", "message-actions", "message-bubbles"]
    .map(name => readFile(`src/app/styles/${name}.css`, "utf8")))).join("\n");
  html = `<!doctype html><style>${styles}#root{position:relative;width:250px;height:250px}</style><div id="root"></div><script>${script}</script>`;
});

for (const mode of ["download", "sticker", "upload"]) {
  test(`${mode} ring follows rapid progress updates on the next frame`, async ({ page }) => {
    await page.route("http://media-progress.test/**", route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`http://media-progress.test/?mode=${mode}`);
    const arc = page.locator(mode === "upload" ? ".upload-ring__bar" : ".media-loading__arc");
    await expect(arc).toBeVisible();
    const samples = await arc.evaluate(async node => {
      const update = (window as unknown as { setProgress: (received: number) => void }).setProgress;
      const frame = () => new Promise(requestAnimationFrame);
      await frame();
      await frame();
      const samples: { received: number; actual: number; expected: number }[] = [];
      for (const received of [100, 300, 650, 920, 1000]) {
        update(received);
        await frame();
        samples.push({ received, actual: parseFloat(getComputedStyle(node).strokeDashoffset),
          expected: Number(node.getAttribute("stroke-dashoffset")) });
      }
      return samples;
    });
    for (const sample of samples) {
      expect(sample.actual, `${sample.received / 10}% must be painted without trailing behind`).toBeCloseTo(sample.expected, 3);
    }
    expect(samples.at(-1)!.actual).toBeCloseTo(0, 3);
  });
}
