import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { securityServer } from "../tests/helpers/securityServer";

const label = process.argv[2] || "current";
if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid measurement label");
const output = new URL("../../output/interface-loading/", import.meta.url);
await mkdir(output, { recursive: true });
const server = await securityServer();
let browser;
try {
  browser = await chromium.launch();
  const samples = [];
  for (let round = 0; round < 3; round++) {
    const context = await browser.newContext({ baseURL: server.base, reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
    try {
      await context.addInitScript(token => {
        localStorage.setItem("pulse-chat-token", token);
        localStorage.setItem("pulse-krisp", "0");
        localStorage.setItem("pulse-browser-ns", "0");
      }, server.token);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".workspace", { state: "visible", timeout: 30000 });
      const workspaceVisibleMs = await page.evaluate(() => performance.now());
      // Include chunks requested by mounted but closed panels after hydration.
      await page.waitForTimeout(1000);
      const resources = await page.evaluate(() => performance.getEntriesByType("resource")
        .filter(entry => new URL(entry.name).pathname.endsWith(".js"))
        .map(entry => { const item = entry as PerformanceResourceTiming;
          return { path: new URL(item.name).pathname, encodedBytes: item.encodedBodySize, decodedBytes: item.decodedBodySize, transferBytes: item.transferSize }; }));
      const metrics = await cdp.send("Performance.getMetrics");
      samples.push({ round, workspaceVisibleMs, resources,
        encodedJsBytes: resources.reduce((sum, resource) => sum + resource.encodedBytes, 0),
        decodedJsBytes: resources.reduce((sum, resource) => sum + resource.decodedBytes, 0),
        metrics: Object.fromEntries(metrics.metrics.filter(metric => ["ScriptDuration", "TaskDuration", "JSHeapUsedSize"].includes(metric.name)).map(metric => [metric.name, metric.value])), errors });
      if (errors.length) throw new Error(errors.join("\n"));
    } finally { await context.close(); }
  }
  const report = { label, browser: browser.version(), samples,
    note: "Protected production Next.js build, isolated local fixture and fresh browser contexts. Authenticated workspace, reduced motion, no throttling, 1 second after workspace visibility. Three runs; includes fixture/network and scheduler variation." };
  await writeFile(new URL(`${label}-startup.json`, output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ label, browser: report.browser, samples: samples.map(({ resources, ...sample }) => ({ ...sample, javascriptRequests: resources.length })) }, null, 2));
} finally { await browser?.close(); await server.stop(); }
