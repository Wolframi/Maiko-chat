import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge" });
let bundle: string;

test.beforeAll(async () => {
  bundle = (await build({
    stdin: {
      contents: `
        import React, {useState} from "react";
        import {createRoot} from "react-dom/client";
        import {Composer} from "./src/components/chat/Composer";
        import {uploadFile} from "./src/lib/files";
        window.uploadFile = uploadFile;
        function App() {
          const [uploaded, setUploaded] = useState([]);
          return <><Composer onSend={() => {}} onTyping={() => {}} stickerPacks={[]}
            onSendFiles={async files => {
              const results = [];
              for (const file of files) results.push(await uploadFile(file, "test-token"));
              setUploaded(results);
              return {ok: true, completed: files};
            }} /><ul id="uploaded">{uploaded.map(file => <li key={file.name}>{file.name}</li>)}</ul></>;
        }
        createRoot(document.getElementById("root")).render(<App/>);`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  })).outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route("http://uploads.test/", route => route.fulfill({
    contentType: "text/html", body: '<!doctype html><div id="root"></div>',
  }));
  await page.goto("http://uploads.test/");
  await page.addScriptTag({ content: bundle });
});

test("the composer accepts mixed formats and sends them through the server fallback", async ({ page }) => {
  const names = ["Отчёт.docx", "таблица.xlsx", "page.html", "image.svg", "data.xml", "app.js", "script.ps1", "scan.tiff", "archive.7z", "unknown.custom", "README", "empty.txt"];
  const received: string[] = [];
  await page.route("**/api/upload**", async route => {
    if (route.request().url().includes("/direct/")) {
      await route.fulfill({ status: 404, contentType: "text/html", body: "Not found" });
      return;
    }
    expect(route.request().headers()["x-pulse-token"]).toBe("test-token");
    const body = route.request().postDataBuffer()!.toString("utf8");
    const name = /name="originalName"\r\n\r\n([^\r\n]+)/.exec(body)![1];
    received.push(name);
    await route.fulfill({ json: { ok: true, file: { url: "/uploads/key.bin?exp=1&sig=test", name: "server.bin", size: 4, mime: "application/octet-stream" } } });
  });
  await page.locator('input[type="file"]').setInputFiles(names.map(name => ({ name, mimeType: name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".tiff") ? "image/tiff" : "", buffer: Buffer.from(name === "empty.txt" ? "" : "data") })));
  await expect(page.locator(".composer__chip")).toHaveCount(names.length);
  await expect(page.locator(".composer__chip img")).toHaveCount(0);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator("#uploaded li")).toHaveText(names);
  expect(received).toEqual(names);
  await expect(page.locator(".composer__chip")).toHaveCount(0);
});

for (const failure of ["start-network", "start-503", "part-network", "complete-network", "complete-503"]) {
  test(`upload recovers from ${failure} without user retry`, async ({ page }) => {
    let serverUploads = 0;
    let aborted = false;
    await page.route("**/api/upload**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/start")) {
        if (failure === "start-network") return route.abort("failed");
        if (failure === "start-503") return route.fulfill({ status: 503, json: { ok: false, error: "Хранилище недоступно" } });
        return route.fulfill({ json: { ok: true, id: "ticket", parts: [{ partNumber: 1, size: 4, url: "http://uploads.test/api/upload-part" }] } });
      }
      if (pathname === "/api/upload-part") {
        if (failure === "part-network") return route.abort("failed");
        return route.fulfill({ status: 200, headers: { ETag: '"part-etag"' }, body: "" });
      }
      if (pathname.endsWith("/complete")) {
        if (failure === "complete-network") return route.abort("failed");
        return route.fulfill({ status: 503, json: { ok: false, error: "Не удалось сохранить файл" } });
      }
      if (pathname.endsWith("/abort")) {
        aborted = true;
        return route.fulfill({ json: { ok: true } });
      }
      serverUploads++;
      return route.fulfill({ json: { ok: true, file: { url: "/uploads/key.docx", name: "server.docx", size: 4, mime: "application/octet-stream" } } });
    });
    const result = await page.evaluate(async () => {
      const progress: number[] = [];
      const file = await (window as unknown as { uploadFile: typeof import("../src/lib/files").uploadFile }).uploadFile(
        new File(["data"], "Отчёт.docx"), "test-token", { onProgress: value => progress.push(value) },
      );
      return { file, progress };
    });
    expect(result.file.name).toBe("Отчёт.docx");
    expect(result.progress.at(-1)).toBe(1);
    expect(serverUploads).toBe(1);
    if (!failure.startsWith("start")) await expect.poll(() => aborted).toBe(true);
  });
}

for (const status of [400, 401, 413]) {
  test(`direct upload ${status} keeps the error without a fallback`, async ({ page }) => {
    let requests = 0;
    await page.route("**/api/upload**", route => {
      requests++;
      return route.fulfill({ status, json: { ok: false, error: "Отказ сервера" } });
    });
    const result = await page.evaluate(async () => {
      try {
        await (window as unknown as { uploadFile: typeof import("../src/lib/files").uploadFile }).uploadFile(new File(["data"], "file.bin"), "test-token");
        return "unexpected success";
      } catch (error) { return (error as Error).message; }
    });
    expect(result).toBe("Отказ сервера");
    expect(requests).toBe(1);
  });
}

test("cancelling the direct upload never starts a server upload", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/upload**", async route => {
    requests++;
    await route.fulfill({ status: 503, json: { ok: false } });
  });
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await (window as unknown as { uploadFile: typeof import("../src/lib/files").uploadFile }).uploadFile(new File(["data"], "file.bin"), "test-token", { signal: controller.signal });
      return "unexpected success";
    } catch (error) { return (error as Error).message; }
  });
  expect(result).toBe("Загрузка отменена");
  expect(requests).toBe(0);
});
