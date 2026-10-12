import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "msedge", actionTimeout: 15_000, permissions: ["camera", "microphone"], launchOptions: {
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
} });

async function login(page: Page, username: string, password: string) {
  await page.goto("/");
  await page.getByPlaceholder("artem").fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
  const previous = page.getByRole("button", { name: /^Завершить(?: звонок)?$/ });
  if (await previous.count()) await previous.click();
}

test("call demo audio stays in its own player and sender across repeated shares with a muted mic", async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses local demo accounts only");
  const a = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  const b = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  try {
    const caller = await a.newPage();
    const receiver = await b.newPage();
    await caller.addInitScript(() => {
      const pcs: RTCPeerConnection[] = [];
      const NativePc = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePc {
        constructor(config?: RTCConfiguration) { super(config); pcs.push(this); }
      };
      Object.assign(window, { __audioPcs: pcs });
      // Synthetic display/audio source: tests never capture the user's desktop.
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 160; canvas.height = 90;
        canvas.getContext("2d")!.fillRect(0, 0, 160, 90);
        const stream = canvas.captureStream(5);
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start();
        const audio = destination.stream.getAudioTracks()[0];
        stream.addTrack(audio);
        audio.addEventListener("ended", () => { oscillator.stop(); void context.close(); }, { once: true });
        return stream;
      };
    });
    await login(caller, "artem", "Artem1234!");
    await login(receiver, "alice", "Alice1234!");
    await caller.getByRole("button", { name: "Люди", exact: true }).click();
    await caller.getByRole("button", { name: /Алиса.*@alice/ }).click();
    await receiver.getByRole("button", { name: "Люди", exact: true }).click();
    await receiver.getByRole("button", { name: /Artem.*@artem/ }).click();
    await caller.getByRole("button", { name: "Звонок", exact: true }).click();
    await receiver.getByRole("button", { name: "Ответить", exact: true }).click();
    await expect.poll(() => caller.evaluate(() =>
      (window as unknown as { __audioPcs: RTCPeerConnection[] }).__audioPcs.some(pc => pc.connectionState === "connected"))).toBe(true);
    await caller.getByRole("button", { name: "Выключить микрофон", exact: true }).click();
    await receiver.evaluate(() => {
      const peer = JSON.parse(sessionStorage.getItem("pulse-media-resume")!).peerId;
      localStorage.setItem("pulse-screen-volume", JSON.stringify({ [peer]: 0.25 }));
      window.dispatchEvent(new StorageEvent("storage", { key: "pulse-screen-volume" }));
    });
    const audioState = () => receiver.locator("audio").evaluateAll(nodes => (nodes as HTMLAudioElement[])
      .filter(audio => (audio.srcObject as MediaStream | null)?.getAudioTracks().length)
      .map(audio => ({ tracks: (audio.srcObject as MediaStream).getAudioTracks().length, volume: audio.volume }))
      .sort((x, y) => x.volume - y.volume));
    let audioSections: number | undefined;
    for (let i = 0; i < 3; i++) {
      await caller.getByRole("button", { name: "Демонстрация экрана", exact: true }).click();
      await expect.poll(audioState).toEqual([{ tracks: 1, volume: 0.25 }, { tracks: 1, volume: 1 }]);
      const sections = await caller.evaluate(() => {
        const pcs = (window as unknown as { __audioPcs: RTCPeerConnection[] }).__audioPcs;
        return (pcs.find(pc => pc.connectionState === "connected")?.localDescription?.sdp.match(/^m=audio /gm) || []).length;
      });
      audioSections ??= sections;
      expect(sections).toBe(2);
      expect(sections).toBe(audioSections);
      await caller.getByRole("button", { name: "Остановить демонстрацию", exact: true }).click();
    }
    await caller.getByRole("button", { name: /^Завершить(?: звонок)?$/ }).click();
  } finally { await a.close(); await b.close(); }
});

test("two local peers keep camera video while toggling mic and headphones", async ({ browser, baseURL }) => {
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses local demo accounts only");
  const a = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  const b = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  try {
    const caller = await a.newPage();
    const receiver = await b.newPage();
    await login(caller, "artem", "Artem1234!");
    await login(receiver, "alice", "Alice1234!");
    await caller.getByRole("button", { name: "Люди", exact: true }).click();
    await caller.getByRole("button", { name: /Алиса.*@alice/ }).click();
    await receiver.getByRole("button", { name: "Люди", exact: true }).click();
    await receiver.getByRole("button", { name: /Artem.*@artem/ }).click();
    await caller.getByRole("button", { name: "Звонок", exact: true }).click();
    await receiver.getByRole("button", { name: "Ответить", exact: true }).click();
    await caller.getByRole("button", { name: "Включить камеру", exact: true }).click();
    await receiver.getByRole("button", { name: "Включить камеру", exact: true }).click();
    await expect.poll(() => caller.locator("video").evaluateAll((nodes) => nodes.filter((node) => (node as HTMLVideoElement).videoWidth > 0).length)).toBeGreaterThanOrEqual(2);
    await expect(caller.locator(".connection-signal--good, .connection-signal--ok, .connection-signal--poor").first()).toBeVisible();
    await caller.evaluate(() => {
      const state = [...document.querySelectorAll("video")].filter((video) => video.videoWidth > 0).map((video) => {
        const item = { video, stream: video.srcObject, resets: 0 };
        video.addEventListener("emptied", () => item.resets++);
        return item;
      });
      Object.assign(window, { __callVideoState: state });
    });
    for (let i = 0; i < 3; i++) {
      await caller.getByRole("button", { name: /^(Включить|Выключить) микрофон$/ }).click();
      await caller.getByRole("button", { name: /^(Включить|Отключить) звук$/ }).click();
    }
    const state = await caller.evaluate(() => {
      const items = (window as unknown as { __callVideoState: { video: HTMLVideoElement; stream: unknown; resets: number }[] }).__callVideoState;
      return { stable: items.every((v) => v.video.isConnected && v.video.srcObject === v.stream), resets: items.reduce((n, v) => n + v.resets, 0) };
    });
    expect(state).toEqual({ stable: true, resets: 0 });
    await caller.getByRole("button", { name: /^Завершить(?: звонок)?$/ }).click();
  } finally { await a.close(); await b.close(); }
});

test("one or both pages reload into the same call with mute, headphones, camera and duration preserved", async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses local demo accounts only");
  const a = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  const b = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  const saved = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("pulse-media-resume") || "null"));
  const connectedVideo = (page: Page) => expect.poll(() => page.locator("video").evaluateAll(nodes =>
    nodes.filter(node => (node as HTMLVideoElement).videoWidth > 0).length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  try {
    const caller = await a.newPage();
    const receiver = await b.newPage();
    await login(caller, "artem", "Artem1234!");
    await login(receiver, "alice", "Alice1234!");
    await caller.getByRole("button", { name: "Люди", exact: true }).click();
    await caller.getByRole("button", { name: /Алиса.*@alice/ }).click();
    await receiver.getByRole("button", { name: "Люди", exact: true }).click();
    await receiver.getByRole("button", { name: /Artem.*@artem/ }).click();
    await caller.getByRole("button", { name: "Звонок", exact: true }).click();
    await receiver.getByRole("button", { name: "Ответить", exact: true }).click();
    await caller.getByRole("button", { name: "Включить камеру", exact: true }).click();
    await receiver.getByRole("button", { name: "Включить камеру", exact: true }).click();
    await connectedVideo(caller);
    await caller.getByRole("button", { name: "Отключить звук", exact: true }).click();
    await expect.poll(() => saved(caller)).toMatchObject({ muted: true, deafened: true, cameraOff: false });
    const original = await saved(caller);
    expect(original.connectedAt).toBeGreaterThan(0);
    await caller.reload();
    await expect(caller.locator(".hologram-maiko")).toBeVisible();
    await expect(caller.getByRole("button", { name: /^Завершить(?: звонок)?$/ })).toBeVisible();
    await connectedVideo(caller);
    expect(await saved(caller)).toMatchObject({ callId: original.callId, connectedAt: original.connectedAt,
      muted: true, deafened: true, cameraOff: false });
    await expect(receiver.getByRole("button", { name: "Ответить", exact: true })).toHaveCount(0);

    await Promise.all([caller.reload(), receiver.reload()]);
    await connectedVideo(caller);
    await connectedVideo(receiver);
    await expect.poll(() => saved(caller)).toMatchObject({ callId: original.callId, connectedAt: original.connectedAt,
      muted: true, deafened: true, cameraOff: false });
    await expect.poll(() => saved(receiver)).toMatchObject({ callId: original.callId, cameraOff: false });
    await expect(caller.getByRole("button", { name: "Ответить", exact: true })).toHaveCount(0);
    await expect(receiver.getByRole("button", { name: "Ответить", exact: true })).toHaveCount(0);
    await caller.getByRole("button", { name: /^Завершить(?: звонок)?$/ }).click();
    await expect.poll(() => saved(caller)).toBeNull();
    await caller.reload();
    await expect(caller.locator(".workspace")).toBeVisible();
    await expect(caller.getByRole("button", { name: /^Завершить(?: звонок)?$/ })).toHaveCount(0);
  } finally { await a.close(); await b.close(); }
});
