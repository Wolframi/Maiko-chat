import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

test.use({ channel: "msedge" });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let bundle: string;
let video: Buffer;

type Harness = Window & {
  show: (kind: string, src: string, offset?: number) => void;
  picker: (open: boolean) => void;
};

test.beforeAll(async () => {
  bundle = (await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { ChatImage } from "./src/components/chat/ChatImage";
        import { AnimatedSticker } from "./src/components/chat/AnimatedSticker";
        import { VideoPreview } from "./src/components/chat/VideoPreview";
        import { GifPicker } from "./src/components/chat/GifPicker";
        const root = createRoot(document.getElementById("root"));
        window.show = (kind, src, offset = 0) => flushSync(() => root.render(
          <React.StrictMode>
            <div id="scroller" style={{height: 240, overflowY: "auto"}}>
              <div style={{height: offset}} />
              <div id="media" style={{width: 160, height: 160}}>
                {kind === "sticker" ? <AnimatedSticker src={src} style={{width: "100%", height: "100%"}} />
                  : kind === "video" ? <VideoPreview src={src} />
                  : <ChatImage src={src} alt={kind} style={{width: "100%", height: "100%"}} />}
              </div>
              <div style={{height: 1800}} />
            </div>
          </React.StrictMode>
        ));
        window.picker = open => flushSync(() => root.render(
          <React.StrictMode><GifPicker open={open} onClose={() => {}} onSelect={() => {}} /></React.StrictMode>
        ));`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  })).outputFiles[0].text;
  video = await readFile("e2e/fixtures/media-loading.webm");
});

test.beforeEach(async ({ page }) => {
  await page.route("http://media-loading.test/", route => route.fulfill({
    contentType: "text/html", body: `<!doctype html><style>
      #root{width:440px}.gif-picker{width:440px}.gif-picker__grid{height:300px;overflow:auto}
      .gif-picker__mosaic{position:relative}.gif-picker__mosaic-width{width:100%}
      .gif-picker__item{position:absolute}.gif-picker__item img{width:100%;height:100%}
      #media video{width:100%;height:100%}
    </style><div id="root"></div>`,
  }));
  await page.goto("http://media-loading.test/");
  await page.addScriptTag({ content: bundle });
});

for (const kind of ["photo", "GIF", "video", "sticker"]) {
  test(`${kind} loads ahead inside a scroller without downloading distant items`, async ({ page }) => {
    const requests: string[] = [];
    await page.route("**/uploads/**", route => {
      requests.push(route.request().url());
      const movie = (kind === "video" || kind === "sticker") && !route.request().url().includes("poster=1");
      return route.fulfill({ contentType: movie ? "video/webm" : "image/png", body: movie ? video : png });
    });
    await page.evaluate(kind => (window as unknown as Harness).show(kind, "/uploads/item", 1800), kind);
    // Wait for observer delivery, rather than relying on arbitrary sleeps.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(requests).toHaveLength(0);
    await page.locator("#scroller").evaluate(node => { node.scrollTop = 1450; });
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    // The item is still below the scroll container's visible area.
    expect(await page.locator("#media").evaluate(node => node.getBoundingClientRect().top
      > document.querySelector("#scroller")!.getBoundingClientRect().bottom)).toBe(true);
    if (kind === "sticker") await expect.poll(() => page.locator("video").evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    await page.locator("#scroller").evaluate(node => { node.scrollTop = 1800; });
    if (kind === "sticker") {
      await expect.poll(() => page.locator("video").evaluate(node => node instanceof HTMLVideoElement && !node.paused && node.videoWidth > 0)).toBe(true);
      await page.locator("#scroller").evaluate(node => { node.scrollTop = 0; });
      await expect.poll(() => page.locator("video").evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    } else {
      await expect.poll(() => page.locator("#media img, #media video").evaluate(node => node instanceof HTMLVideoElement
        ? node.videoWidth > 0 : (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
    }
  });
}

test("renewed credentials preserve loaded photos, GIFs and videos", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/uploads/**", route => {
    requests.push(route.request().url());
    const movie = route.request().url().includes("webm") && !route.request().url().includes("poster=1");
    return route.fulfill({ contentType: movie ? "video/webm" : "image/png", body: movie ? video : png });
  });
  for (const kind of ["photo", "GIF", "video", "sticker"]) {
    const name = `${kind}.${kind === "photo" || kind === "GIF" ? "png" : "webm"}`;
    await page.evaluate(({ kind, name }) => (window as unknown as Harness).show(kind, `/uploads/${name}?exp=1&sig=old`), { kind, name });
    await expect.poll(() => page.locator("#media img, #media video").evaluate(node => node instanceof HTMLVideoElement
      ? node.videoWidth > 0 : (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
    const count = requests.length;
    await page.evaluate(({ kind, name }) => (window as unknown as Harness).show(kind, `/uploads/${name}?exp=2&sig=new`), { kind, name });
    await expect(page.locator("#media img, #media video")).toHaveAttribute("src", `/uploads/${name}?exp=1&sig=old${kind === "video" ? "&w=430&poster=1" : ""}`);
    expect(requests).toHaveLength(count);
  }
});

test("failed thumbnails fall back to originals and manual retry works repeatedly", async ({ page }) => {
  let healthy = false;
  await page.route("**/uploads/**", route => healthy
    ? route.fulfill({ contentType: "image/png", body: png })
    : route.fulfill({ status: 503 }));
  await page.evaluate(() => (window as unknown as Harness).show("photo", "/uploads/retry.png?w=430&exp=1&sig=old"));
  const retry = page.getByRole("button", { name: "Повторить загрузку" });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toBeVisible();
  healthy = true;
  await retry.press("Enter");
  await expect.poll(() => page.locator("img").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.locator("img")).toHaveAttribute("src", /retry=3/);
  await expect(page.locator("img")).not.toHaveAttribute("src", /w=430/);
});

test("a video cover avoids video requests; a missing cover uses the browser fallback", async ({ page }) => {
  const requests: string[] = [];
  let available = true;
  await page.route("**/uploads/**", route => {
    const url = route.request().url();
    requests.push(url);
    if (url.includes("poster=1")) return available
      ? route.fulfill({ contentType: "image/png", body: png })
      : route.fulfill({ status: 503 });
    return route.fulfill({ contentType: "video/webm", body: video });
  });
  await page.evaluate(() => (window as unknown as Harness).show("video", "/uploads/covered.webm?exp=1&sig=valid"));
  await expect.poll(() => page.locator("#media img").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("poster=1");
  await expect(page.locator("video")).toHaveCount(0);
  available = false;
  await page.evaluate(() => (window as unknown as Harness).show("video", "/uploads/no-cover.webm?exp=1&sig=valid"));
  await expect.poll(() => page.locator("video").evaluate(node => (node as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
});

test("a slow GIF search cannot replace a newer search, and reopening keeps the query", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let slowStarted = false;
  const searches: string[] = [];
  await page.route("**/api/gif?**", async route => {
    const query = new URL(route.request().url()).searchParams.get("q") || "trending";
    searches.push(query);
    if (query === "slow") { slowStarted = true; await gate; }
    await route.fulfill({ json: { results: [{ id: query, title: query, url: "/uploads/gif.png", preview: "/uploads/gif.png", width: 100, height: 100 }], next: "" } }).catch(() => {});
  });
  await page.route("**/uploads/**", route => route.fulfill({ contentType: "image/png", body: png }));
  try {
    await page.evaluate(() => (window as unknown as Harness).picker(true));
    await expect(page.getByTitle("trending", { exact: true })).toBeVisible();
    await page.getByPlaceholder("Поиск GIF...").fill("slow");
    await expect.poll(() => slowStarted).toBe(true);
    await page.getByPlaceholder("Поиск GIF...").fill("newest");
    await expect(page.getByTitle("newest", { exact: true })).toBeVisible();
    release();
    await expect(page.getByTitle("slow", { exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as unknown as Harness).picker(false));
    await page.evaluate(() => (window as unknown as Harness).picker(true));
    await expect(page.getByTitle("newest", { exact: true })).toBeVisible();
    expect(searches.filter(query => query === "newest")).toHaveLength(1);
  } finally { release(); }
});
