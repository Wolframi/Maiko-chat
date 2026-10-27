import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ channel: "msedge", viewport: { width: 1280, height: 900 } });

const stageOrder = (page: Page) => page.locator(".call__screens > [data-call-tile-id]")
  .evaluateAll((tiles) => tiles.map((tile) => (tile as HTMLElement).dataset.callTileId));

async function dragTile(page: Page, from: Locator, to: Locator) {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (!start || !end) throw new Error("Call tiles must be visible");
  // The lower portion of a share contains volume controls, not a drag handle.
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 4);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  Object.assign(page, { callTileErrors: errors });
  await page.goto("/call-preview");
  await expect(page.locator(".call-preview")).toHaveAttribute("data-preview-ready", "true");
  await expect(page.locator(".call__screen-pane")).toHaveCount(3);
});

test.afterEach(async ({ page }) => {
  expect((page as Page & { callTileErrors: Error[] }).callTileErrors).toEqual([]);
});

test("one click opens a share without changing the layout, including a single share", async ({ page }) => {
  await expect(page.locator(".call__stage-badge, .call__screen-pane.is-selected")).toHaveCount(0);
  const before = await stageOrder(page);
  const bob = page.locator('.call__screens [data-call-tile-id="bob"]');
  await bob.click({ position: { x: 70, y: 45 } });
  await expect.poll(() => page.evaluate(() => (document.fullscreenElement as HTMLElement)?.dataset.callTileId)).toBe("bob");
  expect(await stageOrder(page)).toEqual(before);
  await bob.click({ position: { x: 70, y: 45 } });
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);

  // Removing a media source must keep each remaining tile visible exactly once.
  await page.evaluate(() => {
    for (const id of ["alice", "kirill"]) {
      const video = document.querySelector<HTMLVideoElement>(`.call__screens [data-call-tile-id="${id}"] video`)!;
      (video.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
    }
  });
  await page.getByRole("button", { name: "Выключить микрофон", exact: true }).click();
  await expect(page.locator(".call__screen-pane")).toHaveCount(1);
  await bob.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (document.fullscreenElement as HTMLElement)?.dataset.callTileId)).toBe("bob");
});

test("drag swaps exactly two screen tiles and preserves their media and volume", async ({ page }) => {
  const before = await stageOrder(page);
  const mediaIds = () => page.locator(".call__screens video").evaluateAll((videos) =>
    Object.fromEntries(videos.map((video) => [
      (video.closest("[data-call-tile-id]") as HTMLElement).dataset.callTileId,
      ((video as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0].id,
    ])),
  );
  const streams = await mediaIds();
  await page.getByRole("slider", { name: "Громкость Экран · Боб", exact: true }).fill("35");
  const bob = page.locator('.call__screens [data-call-tile-id="bob"]');
  const kirill = page.locator('.call__screens [data-call-tile-id="kirill"]');
  await dragTile(page, bob, kirill);
  await expect.poll(() => stageOrder(page)).toEqual([before[0], before[2], before[1]]);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect(await mediaIds()).toEqual(streams);
  await expect(page.getByRole("slider", { name: "Громкость Экран · Боб", exact: true })).toHaveValue("35");
  await page.getByRole("button", { name: "Выключить звук Экран · Боб", exact: true }).click();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(page.getByRole("slider", { name: "Громкость Экран · Боб", exact: true })).toHaveValue("0");
  expect(await stageOrder(page)).toEqual([before[0], before[2], before[1]]);
});

test("drag swaps a camera with another user's share and keeps the share controls usable", async ({ page }) => {
  const camera = page.locator('.call__participants-rail [data-call-tile-id="camera:alice"]');
  const bob = page.locator('.call__screens [data-call-tile-id="bob"]');
  await camera.click({ position: { x: 50, y: 30 } });
  await expect.poll(() => page.evaluate(() => (document.fullscreenElement as HTMLElement)?.dataset.callTileId)).toBe("camera:alice");
  await camera.click({ position: { x: 50, y: 30 } });
  await dragTile(page, camera, bob);
  await expect.poll(() => stageOrder(page)).toEqual(["alice", "camera:alice", "kirill"]);
  const railShare = page.locator('.call__participants-rail [data-call-tile-id="bob"]');
  await expect(railShare).toBeVisible();
  await expect(railShare.getByRole("slider", { name: "Громкость Экран · Боб", exact: true })).toBeVisible();
  await railShare.getByRole("slider", { name: "Громкость Экран · Боб", exact: true }).fill("45");
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  // Check both directions across the stage/rail boundary.
  await dragTile(page, page.locator('.call__screens [data-call-tile-id="camera:alice"]'), railShare);
  await expect.poll(() => stageOrder(page)).toEqual(["alice", "bob", "kirill"]);
  await expect(page.getByRole("slider", { name: "Громкость Экран · Боб", exact: true })).toHaveValue("45");
});

test("cancelled and outside drops keep the layout, keyboard and touch can swap tiles", async ({ page }) => {
  const before = await stageOrder(page);
  const bob = page.locator('.call__screens [data-call-tile-id="bob"]');
  await dragTile(page, bob, page.locator(".call-preview__sidebar header"));
  expect(await stageOrder(page)).toEqual(before);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

  const kirill = page.locator('.call__screens [data-call-tile-id="kirill"]');
  await kirill.focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect.poll(() => stageOrder(page)).toEqual([before[0], before[2], before[1]]);
  await page.setViewportSize({ width: 390, height: 844 });
  // Send actual browser touch input so pointer capture and cancellation are exercised.
  const start = (await bob.boundingBox())!;
  const end = (await kirill.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const origin = { x: start.x + start.width / 2, y: start.y + 6 };
  const destination = { x: end.x + end.width / 2, y: end.y + 6 };
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [origin] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [destination] });
  await expect(page.locator(".is-dragging")).toHaveCount(1);
  await expect(page.locator(".is-drop-target")).toHaveCount(1);
  await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  expect(await stageOrder(page)).toEqual([before[0], before[2], before[1]]);
  await expect(page.locator(".is-dragging, .is-drop-target")).toHaveCount(0);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [origin] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [destination] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => stageOrder(page)).toEqual(before);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await session.detach();
});
