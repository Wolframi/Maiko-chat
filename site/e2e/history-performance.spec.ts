import { expect, test } from "@playwright/test";
import { io } from "socket.io-client";
import { appServer } from "./helpers/appServer";

test.use({ channel: "msedge", viewport: { width: 1280, height: 900 } });

test("long threads load a page, preserve scroll while prepending, virtualize and navigate older replies/search", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const server = await appServer(2500);
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  const historyRequests: Record<string, unknown>[] = [];
  const searchRequests: Record<string, unknown>[] = [];
  try {
    await context.addInitScript(token => localStorage.setItem("pulse-chat-token", token), server.token);
    const page = await context.newPage();
    const trackPackets = (data: string) => {
      for (const frame of data.split("\x1e")) {
        const packet = frame.match(/^42\d*(\[.*)$/);
        if (!packet) continue;
        const [event, payload] = JSON.parse(packet[1]);
        if (event === "history:load") historyRequests.push(payload);
        if (event === "history:search") searchRequests.push(payload);
      }
    };
    page.on("websocket", ws => ws.on("framesent", frame => trackPackets(String(frame.payload))));
    page.on("request", request => {
      if (request.method() === "POST" && request.url().includes("/api/socket/")) trackPackets(request.postData() ?? "");
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.base);
    await page.getByRole("navigation", { name: "Серверы и группы" }).getByRole("button", { name: "Seed Group 0", exact: true }).click();
    const thread = page.locator(".room__messages-wrap");
    const scroller = page.locator(".room__messages");
    const expectPreviousPageVisible = async (from: number, to: number) => {
      await expect.poll(() => scroller.evaluate((element, range) => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll<HTMLElement>("[id^='msg-history-']")).some(row => {
          const index = Number(row.id.slice("msg-history-".length));
          const rect = row.getBoundingClientRect();
          return index >= range.from && index <= range.to && rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
      }, { from, to })).toBe(true);
    };
    await expect(page.locator("#msg-history-2499")).toBeVisible().catch(async error => {
      console.log(JSON.stringify(await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".room__messages");
        const ids = Array.from(document.querySelectorAll("[id^='msg-']"), element => element.id);
        return { errors: document.querySelector(".room__messages-wrap")?.getAttribute("data-loaded-messages"), height: scroller?.clientHeight, total: scroller?.scrollHeight, top: scroller?.scrollTop, first: ids[0], last: ids.at(-1), count: ids.length, html: scroller?.outerHTML.slice(0, 600) };
      })));
      console.log(JSON.stringify({ pageErrors: errors }));
      await page.screenshot({ path: testInfo.outputPath("initial-history-error.png") });
      throw error;
    });
    await expect(thread).toHaveAttribute("data-loaded-messages", "80");
    await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(3);
    expect(await page.locator(".message-block").count()).toBeLessThan(100);
    // Avoid an in-flight native Home/wheel animation continuing across the
    // prepend; this check models moving the scrollbar directly to the top.
    await scroller.dispatchEvent("wheel", { deltaY: 0 });
    const prependFrames = await scroller.evaluate(async element => {
      element.scrollTop = 0;
      const frames: number[] = [];
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        const anchor = element.querySelector("#msg-history-2420");
        if (anchor) frames.push(anchor.getBoundingClientRect().top);
        if (frames.length > 20 && Number(element.parentElement?.dataset.loadedMessages) > 80) break;
      }
      return frames;
    });
    await expect.poll(async () => Number(await thread.getAttribute("data-loaded-messages"))).toBeGreaterThan(80);
    // The boundary of the previous page stays mounted after older messages
    // arrive, rather than the viewport jumping to the newly prepended top.
    await expect(page.locator("#msg-history-2420")).toBeAttached().catch(async error => {
      console.log(JSON.stringify(await page.evaluate(() => {
        const s = document.querySelector<HTMLElement>(".room__messages")!;
        const ids = Array.from(s.querySelectorAll("[id^='msg-']"), element => element.id);
        return { loaded: document.querySelector(".room__messages-wrap")?.getAttribute("data-loaded-messages"), top: s.scrollTop, total: s.scrollHeight, first: ids[0], last: ids.at(-1) };
      })));
      throw error;
    });
    // Check every painted position: restoring an anchor after the prepend used
    // to show a different location for two frames before jumping back.
    expect(prependFrames.length).toBeGreaterThan(2);
    expect(Math.max(...prependFrames) - Math.min(...prependFrames)).toBeLessThan(6);
    expect(await page.locator(".message-block").count()).toBeLessThan(160);
    await page.getByRole("button", { name: "Прокрутить вниз", exact: true }).click();
    await expect(page.locator("#msg-history-2499")).toBeVisible();
    await page.locator("#msg-history-2499 .bubble__reply").click();
    await expect(thread).toHaveAttribute("data-loaded-messages", "51");
    await expect(page.locator("#msg-history-12")).toBeInViewport();
    expect(await page.locator(".message-block").count()).toBeLessThan(160);
    // Incoming messages cannot be appended across the gap to the live edge.
    const peer = io(server.base, { path: "/api/socket", transports: ["websocket"], reconnection: false, auth: { historyPages: 1, chatPatches: 1 } });
    try {
      await new Promise<void>((resolve, reject) => { peer.once("connect", resolve); peer.once("connect_error", reject); });
      expect((await peer.timeout(15_000).emitWithAck("auth:login", { username: "seeduser1", password: "SecurityFixture123!" })).ok).toBe(true);
      expect((await peer.timeout(15_000).emitWithAck("chats:switch", { chatId: "security-group-0" })).ok).toBe(true);
      const incoming = await peer.timeout(15_000).emitWithAck("message", { chatId: "security-group-0", text: "Arrived while viewing old history", clientId: "window-live-peer" });
      expect(incoming.ok, incoming.error).toBe(true);
      await expect(thread).toHaveAttribute("data-loaded-messages", "51");
      await expect(page.locator("#msg-history-12")).toBeInViewport();
    } finally { peer.disconnect(); }
    await page.getByRole("button", { name: "Поиск в чате", exact: true }).click();
    await page.getByPlaceholder("Поиск · Enter далее").fill("History message 1234");
    await expect(page.locator("#msg-history-1234")).toBeInViewport();
    await expect(thread).toHaveAttribute("data-loaded-messages", "81");
    await expect(page.locator(".room__search-count")).toHaveText("1/1");
    await page.screenshot({ path: testInfo.outputPath("virtual-history-search.png") });
    await page.getByPlaceholder("Поиск · Enter далее").fill("");
    await expect(page.getByRole("button", { name: "Следующие сообщения", exact: true })).toHaveCount(0);
    await scroller.dispatchEvent("wheel", { deltaY: 800 });
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(thread).toHaveAttribute("data-loaded-messages", "161");
    await expectPreviousPageVisible(1235, 1274);
    // Prefetch starts before the last row is visible. The reading position
    // stays within the previous page, rather than following the new tail.
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(thread).toHaveAttribute("data-loaded-messages", "241");
    await expectPreviousPageVisible(1275, 1354);
    await page.getByRole("button", { name: "Прокрутить вниз", exact: true }).click();
    await expect(thread).toHaveAttribute("data-loaded-messages", "80");
    await expect(scroller.getByText("Arrived while viewing old history")).toBeInViewport().catch(async error => {
      console.log(JSON.stringify(await page.evaluate(() => {
        const s = document.querySelector<HTMLElement>(".room__messages")!;
        const rect = (element: Element | null) => element?.getBoundingClientRect().toJSON();
        return { top: s.scrollTop, height: s.clientHeight, total: s.scrollHeight, scroller: rect(s), body: rect(document.body), newest: rect(s.querySelector("[id^='msg-']:last-of-type")), tail: s.innerHTML.slice(-1200), pageScroll: [scrollX, scrollY] };
      })));
      await page.screenshot({ path: testInfo.outputPath("latest-window-error.png") });
      throw error;
    });
    const composer = page.getByRole("textbox", { name: "Написать сообщение…" });
    await composer.fill("Live after virtualization");
    await composer.press("Enter");
    await expect(scroller.getByText("Live after virtualization")).toBeInViewport();
    // The last page after a search must also preserve the viewport when
    // hasNewer changes to false (including when search has been cleared).
    const searchInput = page.getByPlaceholder("Поиск · Enter далее");
    await searchInput.fill("History message 2420");
    await expect(page.locator("#msg-history-2420")).toBeInViewport();
    await expect(thread).toHaveAttribute("data-loaded-messages", "81");
    await searchInput.fill("");
    await scroller.dispatchEvent("wheel", { deltaY: 800 });
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(thread).toHaveAttribute("data-loaded-messages", "122");
    await expectPreviousPageVisible(2421, 2460);
    await expect(page.getByRole("button", { name: "Следующие сообщения", exact: true })).toHaveCount(0);
    // Crossing a search page boundary requests another small ID page.
    await searchInput.fill("History message 12");
    await expect(page.locator(".room__search-count")).toHaveText("1/40+");
    for (let index = 0; index < 40; index++) {
      await searchInput.press("Enter");
      await expect(page.locator(".room__search-count")).toHaveText(index < 39 ? `${index + 2}/40+` : "41/80+");
    }
    await expect(page.locator("#msg-history-1229")).toBeInViewport();
    await expect.poll(async () => Number(await thread.getAttribute("data-loaded-messages"))).toBeLessThanOrEqual(81);
    await searchInput.fill("History message 2345");
    await searchInput.fill("History message 345");
    await expect(page.locator("#msg-history-345")).toBeInViewport();
    await expect(page.locator(".room__search-count")).toHaveText("1/1");
    await searchInput.fill("");
    // Sending from a history window returns to the live edge without a gap.
    await composer.fill("Sent from old history");
    await composer.press("Enter");
    await expect(scroller.getByText("Sent from old history")).toBeInViewport();
    await expect.poll(async () => Number(await thread.getAttribute("data-loaded-messages"))).toBeLessThan(85);
    expect(await page.locator(".message-block").count()).toBeLessThan(160);
    expect(errors).toEqual([]);
    expect(historyRequests.some(request => request.all)).toBe(false);
    expect(historyRequests.some(request => request.around === "history-12")).toBe(true);
    expect(searchRequests.some(request => request.after)).toBe(true);
    console.log(JSON.stringify({ initialMessages: 80, searchWindowMessages: 81, historyRequests: historyRequests.length, searchRequests: searchRequests.length, renderedMessageNodes: await page.locator(".message-block").count() }));
  } finally { await context.close(); await server.stop(); }
});
