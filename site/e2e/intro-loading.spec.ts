import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MaikoIntroPreload } from "../src/components/chat/MaikoIntroPreload";

test.use({ channel: "msedge", viewport: { width: 700, height: 600 } });

test("a slow download plays the particle assembly once and continues into the dance", async ({ page }) => {
  const bundle = (await build({ stdin: {
    contents: `import React from "react"; import { createRoot } from "react-dom/client";
      import { HologramMaiko } from "./src/components/chat/HologramMaiko";
      window.introReady = [];
      createRoot(document.getElementById("root")).render(<HologramMaiko onReady={duration => window.introReady.push(duration)} />);`,
    loader: "tsx", resolveDir: process.cwd(),
  }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  let previewRequests = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("http://intro-loading.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body:
      '<style>body{margin:0;background:#0c0c0e}.hologram-maiko{position:fixed;inset:0;width:100vw;height:100vh}</style><div id="root"></div>' });
    if (url.pathname.endsWith("maiko-atoms.bin")) { previewRequests++; return route.fulfill({ status: 404 }); }
    await gate;
    // Fetch interception receives an already decoded HTTP body in Chromium.
    return route.fulfill({ contentType: "application/octet-stream",
      body: await readFile(`public${url.pathname.replace(/\.gz$/, "")}`) });
  });
  try {
    await page.goto("http://intro-loading.test/");
    await page.addScriptTag({ content: bundle });
    await expect(page.getByText("Загружаем Майко…")).toHaveCount(0);
    await expect(page.locator("canvas")).toHaveCount(1);
    await expect(page.locator("canvas")).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { introReady: number[] }).introReady)).toEqual([]);
    release();
    await expect.poll(() => page.evaluate(() => (window as unknown as { introReady: number[] }).introReady.length)).toBe(1);
    await expect(page.locator("canvas")).toHaveCount(1);
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.locator("canvas")).toHaveAttribute("data-maiko-initial-time", "0");
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(previewRequests).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { introReady: number[] }).introReady)).toEqual([8150]);
    await page.screenshot({ path: "test-results/intro-first-model-frame.png" });
    const first = await page.screenshot();
    await page.evaluate(() => new Promise<void>(resolve => {
      const start = performance.now();
      const tick = () => performance.now() - start > 500 ? resolve() : requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    }));
    expect(await page.screenshot()).not.toEqual(first);
    await page.evaluate(() => new Promise<void>(resolve => {
      const start = performance.now();
      const tick = () => performance.now() - start > 1200 ? resolve() : requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    }));
    const assembled = await page.screenshot({ path: "test-results/intro-assembled-model.png" });
    expect(assembled).not.toEqual(first);
    expect(await page.evaluate(() => (window as unknown as { introReady: number[] }).introReady)).toEqual([8150]);
    await expect(page.locator("canvas")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally { release(); }
});

test("the selected dance preloads before chat JavaScript, shares the fetch and stays cached", async ({ page }) => {
  const bundle = (await build({ stdin: {
    contents: `import React from "react"; import { createRoot } from "react-dom/client";
      import { HologramMaiko } from "./src/components/chat/HologramMaiko";
      window.introReady = [];
      createRoot(document.getElementById("root")).render(<HologramMaiko intro="samba" onReady={duration => window.introReady.push(duration)} />);`,
    loader: "tsx", resolveDir: process.cwd(),
  }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  const compressed = gzipSync(await readFile("public/models/maiko-samba.bin"), { level: 9 });
  const requests: string[] = [];
  const hint = renderToString(createElement(MaikoIntroPreload, { intro: "samba" }));
  expect(hint).toContain('rel="preload"');
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/models/")) {
      requests.push(req.url);
      if (!req.url.startsWith("/models/maiko-samba.bin.gz?")) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Encoding": "gzip",
        "Content-Length": compressed.length, "Cache-Control": "public, max-age=31536000, immutable" });
      res.end(compressed);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`${hint}<style>body{margin:0;background:#0c0c0e}.hologram-maiko{position:fixed;inset:0;width:100vw;height:100vh}</style><div id="root"></div>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (let visit = 0; visit < 2; visit++) {
      await page.goto(origin);
      await expect.poll(() => requests.length).toBe(1);
      await page.addScriptTag({ content: bundle });
      await expect.poll(() => page.evaluate(() => (window as unknown as { introReady: number[] }).introReady)).toEqual([8150]);
      await expect(page.locator('canvas[data-maiko-intro="samba"]')).toHaveAttribute("data-maiko-renderer", /webgl|canvas/);
      expect(requests).toHaveLength(1);
      const resource = await page.evaluate(() => performance.getEntriesByType("resource")
        .find(entry => entry.name.includes("maiko-samba.bin.gz"))?.toJSON());
      expect(resource?.initiatorType).toBe("link");
      if (visit === 0) {
        expect(resource?.encodedBodySize).toBe(compressed.length);
        expect(resource?.decodedBodySize).toBeGreaterThan(compressed.length);
      } else expect(resource?.transferSize).toBe(0);
      if (visit === 0) await page.screenshot({ path: "test-results/intro-preloaded.png" });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a failed model download uses the small model without repeating the request", async ({ page }) => {
  const bundle = (await build({ stdin: {
    contents: `import React from "react"; import { createRoot } from "react-dom/client";
      import { HologramMaiko } from "./src/components/chat/HologramMaiko";
      window.introReady = [];
      createRoot(document.getElementById("root")).render(<HologramMaiko intro="hiphop" onReady={duration => window.introReady.push(duration)} />);`,
    loader: "tsx", resolveDir: process.cwd(),
  }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  let downloads = 0;
  await page.route("http://intro-failed.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    if (path.endsWith("maiko-atoms.bin")) return route.fulfill({ body: await readFile("public/models/maiko-atoms.bin") });
    downloads++;
    return route.fulfill({ status: 503, body: "Unavailable" });
  });
  await page.goto("http://intro-failed.test/");
  await page.addScriptTag({ content: bundle });
  await expect.poll(() => page.evaluate(() => (window as unknown as { introReady: number[] }).introReady)).toEqual([0]);
  await expect(page.locator("canvas")).toHaveCount(1);
  expect(downloads).toBe(1);
});
