import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

test.use({ channel: "msedge" });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let bundle: string;
let video: Buffer;

type Harness = Window & {
  show: (kind: string, src: string, offset?: number, microPreview?: string) => void;
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
        window.show = (kind, src, offset = 0, microPreview) => flushSync(() => root.render(
          <React.StrictMode>
            <div id="scroller" style={{height: 240, overflowY: "auto"}}>
              <div style={{height: offset}} />
              <div id="media" style={{width: 160, height: 160, position: "relative"}}>
                {kind === "sticker" ? <AnimatedSticker src={src} style={{width: "100%", height: "100%"}} />
                  : kind === "video" ? <VideoPreview src={src} microPreview={microPreview} />
                  : <ChatImage src={src} microPreview={microPreview} resolveMicroPreview={kind === "photo"} alt={kind} style={{width: "100%", height: "100%"}} />}
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
      .media-loading{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
      .media-loading__ring{width:40px;height:40px}.media-loading svg{width:100%;height:100%}
    </style><div id="root"></div>`,
  }));
  await page.goto("http://media-loading.test/");
  await page.addScriptTag({ content: bundle });
});

for (const kind of ["photo", "video"]) {
  test(`${kind} shows inline Micro-JPEG while loading and resets it for the next resource`, async ({ page }) => {
    const hash = "data:image/jpeg;base64,/9j/2wBDABcQERQRDhcUEhQaGBcbIjklIh8fIkYyNSk5UkhXVVFIUE5bZoNvW2F8Yk5QcptzfIeLkpSSWG2grJ+OqoOPko3/2wBDARgaGiIeIkMlJUONXlBejY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY3/wAARCAAQACADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAQX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwAAjUAAf//Z";
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/uploads/**", async route => {
      await gate;
      await route.fulfill({ contentType: "image/png", body: png });
    });
    try {
      await page.evaluate(({ kind, hash }) => (window as unknown as Harness).show(kind, "/uploads/slow.png", 0, hash), { kind, hash });
      const placeholder = page.locator(".media-micro-preview");
      await expect(placeholder).toBeVisible();
      await expect(page.locator(".media-loading__ring")).toBeVisible();
      await expect.poll(() => placeholder.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(32);
      await expect(page.locator(".media-loading__value")).toHaveCount(0);
      const frame = await page.locator("#media").boundingBox();
      expect(await placeholder.boundingBox()).toEqual(frame);
      release();
      await expect(placeholder).toHaveCount(0);
      await expect(page.locator(".media-loading")).toHaveCount(0);
      await expect(page.locator("#media img:not(.media-micro-preview)")).toHaveCSS("opacity", "1");
      expect(await page.locator("#media").boundingBox()).toEqual(frame);
      // Signature renewal preserves the loaded resource, without flashing a placeholder.
      await page.evaluate(({ kind, hash }) => (window as unknown as Harness).show(kind, "/uploads/slow.png?exp=2&sig=new", 0, hash), { kind, hash });
      await expect(placeholder).toHaveCount(0);
      const nextGate = new Promise<void>(resolve => { release = resolve; });
      await page.route("**/uploads/next.png*", async route => { await nextGate; await route.fulfill({ contentType: "image/png", body: png }); });
      await page.evaluate(({ kind, hash }) => (window as unknown as Harness).show(kind, "/uploads/next.png", 0, hash), { kind, hash });
      await expect(placeholder).toBeVisible();
      release();
      await expect(placeholder).toHaveCount(0);
    } finally { release(); }
  });
}

for (const fit of ["cover", "contain"]) {
  test(`micro-JPEG uses the photo's ${fit} and object position`, async ({ page }) => {
    await page.addStyleTag({ content: `#media > img { object-fit: ${fit}; object-position: 75% 25%; }` });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/uploads/**", async route => {
      await gate;
      await route.fulfill({ contentType: "image/png", body: png });
    });
    try {
      const preview = `data:image/jpeg;base64,${(await readFile("e2e/fixtures/micro-preview.jpg")).toString("base64")}`;
      await page.evaluate(preview => (window as unknown as Harness).show("photo", "/uploads/crop.png", 0, preview), preview);
      const placeholder = page.locator(".media-micro-preview");
      await expect(placeholder).toHaveCSS("object-fit", fit);
      await expect(placeholder).toHaveCSS("object-position", "75% 25%");
      await expect.poll(() => placeholder.evaluate(node => {
        const image = node as HTMLImageElement;
        return [image.naturalWidth, image.naturalHeight];
      })).toEqual([32, 16]);
      await expect(page.getByRole("progressbar")).toHaveText("");
    } finally { release(); }
  });
}

test("invalid micro-preview metadata cannot hide or break a photo", async ({ page }) => {
  await page.route("**/uploads/**", route => route.fulfill({ contentType: "image/png", body: png }));
  await page.evaluate(() => (window as unknown as Harness).show("photo", "/uploads/invalid.png", 0, "invalid"));
  await expect(page.locator(".media-micro-preview")).toHaveCount(0);
  await expect.poll(() => page.locator("#media img:not(.media-micro-preview)").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
});

test("download progress reflects actual response bytes and stops advancing when the network pauses", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const halfway = Math.floor(png.length / 2);
  const percent = Math.floor(halfway / png.length * 100);
  const css = await readFile("src/app/styles/media-loading.css", "utf8");
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/uploads/progress.png")) {
      requests++;
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      response.write(png.subarray(0, halfway));
      void gate.then(() => { if (!response.destroyed) response.end(png.subarray(halfway)); });
    } else response.end(`<style>${css}</style><div id="root"></div>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await page.goto(origin);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => (window as unknown as Harness).show("photo", "/uploads/progress.png"));
    const ring = page.getByRole("progressbar", { name: "Загрузка медиа" });
    await expect(ring).toHaveAttribute("aria-valuenow", String(percent));
    await expect(ring.locator(".media-loading__value")).toHaveCount(0);
    await expect(ring.locator(".media-loading__arc")).toHaveAttribute("stroke-dashoffset", String(100 - percent));
    await expect(ring.locator(".media-loading__arc")).toHaveCSS("animation-name", "none");
    await page.evaluate(() => new Promise(resolve => {
      let remaining = 12;
      const frame = () => { if (--remaining) requestAnimationFrame(frame); else resolve(null); };
      requestAnimationFrame(frame);
    }));
    await expect(ring).toHaveAttribute("aria-valuenow", String(percent));
    release();
    await expect(ring).toHaveCount(0);
    await expect.poll(() => page.locator("#media img:not(.media-micro-preview)").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
    expect(requests).toBe(1); // The displayed image reuses the transfer's Blob.
  } finally {
    release(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a cold signed photo recovers a late Micro-JPEG and keeps its loading ring until the actual image is ready", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let hashes = 0;
  await page.route("**/uploads/cold.png*", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("microPreview") === "1") {
      hashes++;
      return route.fulfill({ status: hashes === 1 ? 202 : 200,
        json: hashes === 1 ? {} : { microPreview: "data:image/jpeg;base64,/9j/2wBDABcQERQRDhcUEhQaGBcbIjklIh8fIkYyNSk5UkhXVVFIUE5bZoNvW2F8Yk5QcptzfIeLkpSSWG2grJ+OqoOPko3/2wBDARgaGiIeIkMlJUONXlBejY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY3/wAARCAAQACADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAQX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwAAjUAAf//Z" } });
    }
    await gate;
    await route.fulfill({ contentType: "image/png", body: png });
  });
  try {
    await page.evaluate(() => (window as unknown as Harness).show("photo", "/uploads/cold.png?exp=1&sig=valid"));
    await expect(page.locator(".media-loading__ring")).toBeVisible();
    await expect(page.locator(".media-micro-preview")).toBeVisible();
    expect(hashes).toBe(2);
    await expect(page.locator(".media-loading__ring")).toBeVisible();
    release();
    await expect(page.locator(".media-loading")).toHaveCount(0);
    await expect(page.locator(".media-micro-preview")).toHaveCount(0);
    await expect(page.locator("#media img:not(.media-micro-preview)")).toHaveCSS("opacity", "1");
  } finally { release(); }
});

test("an animated sticker keeps its shimmer/ring until a decoded frame and can retry a failed download", async ({ page }) => {
  let healthy = false;
  await page.route("**/uploads/retry-sticker.webm*", route => healthy
    ? route.fulfill({ contentType: "video/webm", body: video }) : route.fulfill({ status: 503 }));
  await page.evaluate(() => (window as unknown as Harness).show("sticker", "/uploads/retry-sticker.webm"));
  const retry = page.getByRole("button", { name: "Повторить загрузку" });
  await expect(retry).toBeVisible();
  await expect(page.locator(".media-loading")).toHaveCount(0);
  healthy = true;
  await retry.click();
  await expect.poll(() => page.locator("video").evaluate(node => (node as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  await expect(page.locator(".media-loading")).toHaveCount(0);
  await expect.poll(() => page.locator("video").evaluate(node => (node as HTMLVideoElement).paused)).toBe(false);
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
      await expect.poll(() => page.locator("#media img:not(.media-micro-preview), #media video").evaluate(node => node instanceof HTMLVideoElement
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
    await expect.poll(() => page.locator("#media img:not(.media-micro-preview), #media video").evaluate(node => node instanceof HTMLVideoElement
      ? node.videoWidth > 0 : (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
    const count = requests.length;
    const shownSource = await page.locator("#media img:not(.media-micro-preview), #media video").getAttribute("src");
    await page.evaluate(({ kind, name }) => (window as unknown as Harness).show(kind, `/uploads/${name}?exp=2&sig=new`), { kind, name });
    await expect(page.locator("#media img:not(.media-micro-preview), #media video")).toHaveAttribute("src", shownSource!);
    expect(requests).toHaveLength(count);
  }
});

test("failed thumbnails fall back to originals and manual retry works repeatedly", async ({ page }) => {
  let healthy = false;
  const requests: string[] = [];
  await page.route("**/uploads/**", route => {
    if (!new URL(route.request().url()).searchParams.has("microPreview")) requests.push(route.request().url());
    return healthy ? route.fulfill({ contentType: "image/png", body: png }) : route.fulfill({ status: 503 });
  });
  await page.evaluate(() => (window as unknown as Harness).show("photo", "/uploads/retry.png?w=430&exp=1&sig=old", 0, "data:image/jpeg;base64,/9j/2wBDABcQERQRDhcUEhQaGBcbIjklIh8fIkYyNSk5UkhXVVFIUE5bZoNvW2F8Yk5QcptzfIeLkpSSWG2grJ+OqoOPko3/2wBDARgaGiIeIkMlJUONXlBejY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY3/wAARCAAQACADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAQX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwAAjUAAf//Z"));
  const retry = page.getByRole("button", { name: "Повторить загрузку" });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toBeVisible();
  healthy = true;
  await retry.press("Enter");
  await expect.poll(() => page.locator("img:not(.media-micro-preview)").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
  expect(requests.at(-1)).toMatch(/retry=3/);
  expect(requests.at(-1)).not.toMatch(/w=430/);
  await expect(page.locator(".media-micro-preview")).toHaveCount(0);
  await expect(page.locator("img:not(.media-micro-preview)")).toHaveCSS("opacity", "1");
});

test("a video cover avoids video requests; a missing cover uses the browser fallback", async ({ page }) => {
  const requests: string[] = [];
  let available = true;
  await page.route("**/uploads/**", route => {
    const url = route.request().url();
    if (new URL(url).searchParams.has("microPreview")) return route.fulfill({ json: { microPreview: "data:image/jpeg;base64,/9j/2wBDABcQERQRDhcUEhQaGBcbIjklIh8fIkYyNSk5UkhXVVFIUE5bZoNvW2F8Yk5QcptzfIeLkpSSWG2grJ+OqoOPko3/2wBDARgaGiIeIkMlJUONXlBejY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY3/wAARCAAQACADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAQX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwAAjUAAf//Z" } });
    requests.push(url);
    if (url.includes("poster=1")) return available
      ? route.fulfill({ contentType: "image/png", body: png })
      : route.fulfill({ status: 503 });
    return route.fulfill({ contentType: "video/webm", body: video });
  });
  await page.evaluate(() => (window as unknown as Harness).show("video", "/uploads/covered.webm?exp=1&sig=valid"));
  await expect.poll(() => page.locator("#media img:not(.media-micro-preview)").evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
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
