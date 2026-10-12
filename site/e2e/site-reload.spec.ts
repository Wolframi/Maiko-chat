import { expect, test } from "@playwright/test";
import { build } from "esbuild";

type DeployHarness = { media: (saved: unknown) => void; freshPersist: (saved: unknown) => void };
type HarnessWindow = Window & { deployTest: DeployHarness };

test.use({ channel: "msedge" });
const bundles = new Map<string, string>();
let deployed = "build-old";
let healthy = true;

test.beforeAll(async () => {
  for (const version of ["build-old", "build-new"]) {
    const result = await build({
      stdin: { resolveDir: process.cwd(), contents: `
        import { watchAppBoot, applyBootId, flushPendingBootReload, getSiteUpdateNotice, requestPendingSiteReload } from './src/lib/liveReload';
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { SiteUpdateNotice } from './src/components/chat/SiteUpdateNotice';
        import { saveMediaResume, peekMediaResume, setLiveMediaSession, registerMediaResumePersist } from './src/lib/mediaResume';
        const handlers = new Map();
        export const socket = {
          connected: true, approved: true,
          on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
          off(name, fn) { handlers.get(name)?.delete(fn); },
          emit(name, data, ack) {
            if (name === 'app:prepare-reload') {
              sessionStorage.setItem('prepares', String(Number(sessionStorage.getItem('prepares') || 0) + 1));
              ack({ ok: socket.approved });
            }
          }
        };
        export function event(name, payload) { for (const fn of handlers.get(name) || []) fn(payload); }
        export { applyBootId, flushPendingBootReload, peekMediaResume, getSiteUpdateNotice, requestPendingSiteReload };
        export function media(saved) {
          saveMediaResume(saved);
          setLiveMediaSession(saved.kind, true);
        }
        export function idle() { setLiveMediaSession('call', false); setLiveMediaSession('voice', false); }
        export function ringing() { setLiveMediaSession('call', true); }
        export function joining() { setLiveMediaSession('voice', true, false); }
        export function freshPersist(saved) { registerMediaResumePersist(() => saveMediaResume(saved)); }
        export function start() {
          sessionStorage.setItem('documents', String(Number(sessionStorage.getItem('documents') || 0) + 1));
          watchAppBoot(socket);
          createRoot(document.body.appendChild(document.createElement('main'))).render(createElement(SiteUpdateNotice));
        }
      ` },
      bundle: true, write: false, platform: "browser", format: "iife", globalName: "deployTest",
      define: { "process.env.NEXT_PUBLIC_SITE_VERSION": JSON.stringify(version) },
    });
    bundles.set(version, result.outputFiles[0].text);
  }
});

test.beforeEach(async ({ page }) => {
  deployed = "build-old";
  healthy = true;
  await page.route("**/api/health", route => route.fulfill({ status: healthy ? 200 : 503,
    contentType: "application/json", body: JSON.stringify({ ok: healthy, buildId: deployed, bootId: "process-restarted" }) }));
  await page.route("**/deploy-harness*", route => route.fulfill({ contentType: "text/html",
    body: `<title>Deploy regression</title><body><script>${bundles.get(deployed)!.replaceAll("</script", "<\\/script")};deployTest.start()</script></body>` }));
  await page.goto("/deploy-harness?chat=keep#messages");
});

const call = { kind: "call", peerId: "peer", peerName: "Алиса", chatId: "dm", callId: "original-call",
  connectedAt: Date.now() - 90_000, mode: "video", muted: true, deafened: true, cameraOff: false, sharingScreen: false };
const voice = { kind: "voice", channelId: "voice", groupId: "group", title: "Общий", muted: true,
  deafened: true, cameraOff: false, sharingScreen: false };

test("a process restart with the same build never reloads the page", async ({ page }) => {
  await page.evaluate("deployTest.event('app:boot', {buildId:'build-old', bootId:'another-process'})");
  await page.waitForTimeout(1800);
  expect(await page.evaluate("sessionStorage.getItem('documents')")).toBe("1");
});

for (const saved of [call, voice]) {
  test(`a deployment reloads once and preserves the ${saved.kind} identity and controls`, async ({ page }) => {
    await page.evaluate(saved => (window as unknown as HarnessWindow).deployTest.media(saved), saved);
    // The final persistence hook must win over an older snapshot.
    await page.evaluate(saved => (window as unknown as HarnessWindow).deployTest.freshPersist(saved), { ...saved, muted: false });
    deployed = "build-new";
    await page.evaluate("for(let i=0;i<6;i++) deployTest.event('app:boot', {buildId:'build-new'})");
    await expect.poll(() => page.evaluate("sessionStorage.getItem('documents')").catch(() => null)).toBe("2");
    expect(await page.evaluate("sessionStorage.getItem('prepares')")).toBe("1");
    expect(await page.evaluate("deployTest.peekMediaResume()")).toMatchObject({ ...saved, muted: false });
    await expect(page).toHaveURL(/chat=keep/);
    await expect(page).toHaveURL(/#messages$/);
    await page.waitForTimeout(1800);
    expect(await page.evaluate("sessionStorage.getItem('documents')")).toBe("2");
  });
}

test("a stale bundle detects a deployment even on its first health response", async ({ page }) => {
  deployed = "build-new";
  await page.route("**/first-poll-harness*", route => {
    const stale = !new URL(route.request().url()).searchParams.has("_b");
    return route.fulfill({ contentType: "text/html", body: `<body><script>${stale ? "sessionStorage.clear();" : ""}
      ${bundles.get(stale ? "build-old" : deployed)};deployTest.start()</script></body>` });
  });
  await page.goto("/first-poll-harness");
  await expect.poll(() => page.evaluate("sessionStorage.getItem('documents')").catch(() => null)).toBe("2");
});

test("a browser screen share gets a notice and reloads only on the user's request", async ({ page }) => {
  await page.evaluate(saved => (window as unknown as HarnessWindow).deployTest.media(saved), { ...call, sharingScreen: true });
  deployed = "build-new";
  await page.evaluate("deployTest.applyBootId('build-new')");
  await page.waitForTimeout(1800);
  expect(await page.evaluate("sessionStorage.getItem('documents')")).toBe("1");
  await expect(page.getByText("Сайт обновился — обновите сайт")).toBeVisible();
  await expect(page.getByText(/При перезагрузке демонстрация остановится/)).toBeVisible();
  await page.evaluate(saved => (window as unknown as HarnessWindow).deployTest.media(saved), call);
  await page.evaluate("deployTest.flushPendingBootReload()");
  await page.waitForTimeout(1800);
  expect(await page.evaluate("sessionStorage.getItem('documents')")).toBe("1");
  await page.getByRole("button", { name: "Обновить сайт", exact: true }).click();
  await expect.poll(() => page.evaluate("sessionStorage.getItem('documents')").catch(() => null)).toBe("2");
});

test("ringing defers reload without auto-answering", async ({ page }) => {
  await page.evaluate("deployTest.ringing()");
  deployed = "build-new";
  await page.evaluate("deployTest.applyBootId('build-new')");
  await page.waitForTimeout(1800);
  expect(await page.evaluate("sessionStorage.getItem('documents')")).toBe("1");
  await page.evaluate("deployTest.idle(); deployTest.flushPendingBootReload()");
  await expect.poll(() => page.evaluate("sessionStorage.getItem('documents')").catch(() => null)).toBe("2");
});

test("an old snapshot cannot reload a voice channel while a new join is pending", async ({ page }) => {
  await page.evaluate(saved => (window as unknown as HarnessWindow).deployTest.media(saved), voice);
  await page.evaluate("deployTest.joining()");
  deployed = "build-new";
  await page.evaluate("deployTest.applyBootId('build-new')");
  await page.waitForTimeout(1800);
  expect(await page.evaluate("sessionStorage.getItem('documents')")).toBe("1");
  await page.evaluate(saved => (window as unknown as HarnessWindow).deployTest.media(saved), { ...voice, channelId: "new-channel" });
  await page.evaluate("deployTest.flushPendingBootReload()");
  await expect.poll(() => page.evaluate("sessionStorage.getItem('documents')").catch(() => null)).toBe("2");
  expect(await page.evaluate("deployTest.peekMediaResume().channelId")).toBe("new-channel");
});

test("an unhealthy server or rejected reservation does not destroy a live call", async ({ page }) => {
  await page.evaluate(saved => (window as unknown as HarnessWindow).deployTest.media(saved), call);
  deployed = "build-new";
  healthy = false;
  await page.evaluate("deployTest.applyBootId('build-new')");
  await page.waitForTimeout(1800);
  expect(await page.evaluate("sessionStorage.getItem('documents')")).toBe("1");
  healthy = true;
  await page.evaluate("deployTest.socket.approved=false; deployTest.flushPendingBootReload()");
  await page.waitForTimeout(1800);
  expect(await page.evaluate("sessionStorage.getItem('documents')")).toBe("1");
  await page.evaluate("deployTest.socket.approved=true; deployTest.flushPendingBootReload()");
  await expect.poll(() => page.evaluate("sessionStorage.getItem('documents')").catch(() => null)).toBe("2");
});

test("polling delivers an update when the socket notification was missed", async ({ page }) => {
  deployed = "build-new";
  await expect.poll(() => page.evaluate("sessionStorage.getItem('documents')").catch(() => null)).toBe("2");
});

test("blocked storage protects a live call and keeps the pending update in memory", async ({ page }) => {
  await page.evaluate(saved => (window as unknown as HarnessWindow).deployTest.media(saved), call);
  await page.evaluate(() => Object.defineProperty(window, "sessionStorage", {
    configurable: true, get() { throw new DOMException("Blocked", "SecurityError"); },
  }));
  deployed = "build-new";
  await page.evaluate("deployTest.applyBootId('build-new')");
  await page.waitForTimeout(1800);
  // The original document still has its blocked-storage getter.
  expect(await page.evaluate(() => { try { void sessionStorage; return false; } catch { return true; } })).toBe(true);
  await page.evaluate("deployTest.idle(); deployTest.flushPendingBootReload()");
  await expect.poll(() => page.evaluate("sessionStorage.getItem('documents')").catch(() => null)).toBe("2");
});
