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

test("camera selection persists and replaces only the camera while keeping failed switches safe", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Uses local demo accounts only");
  const a = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  const b = await browser.newContext({ baseURL, permissions: ["camera", "microphone"] });
  try {
    for (const context of [a, b]) {
      await context.addInitScript(() => {
        localStorage.setItem("pulse-krisp", "0");
        localStorage.setItem("pulse-browser-ns", "0");
      });
      // Local peers use host candidates; this test does not depend on public TURN/STUN.
      await context.route("**/api/ice", route => route.fulfill({ json: { iceServers: [{ urls: "stun:127.0.0.1:9" }] } }));
    }
    const caller = await a.newPage();
    const receiver = await b.newPage();
    caller.setDefaultTimeout(45_000);
    receiver.setDefaultTimeout(45_000);
    await receiver.addInitScript(() => {
      const NativePc = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePc {
        constructor(config?: RTCConfiguration) { super({ ...config, iceServers: [] }); }
      };
    });
    await caller.addInitScript(() => {
      localStorage.removeItem("pulse-camera-device");
      const pcs: RTCPeerConnection[] = [];
      const NativePc = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePc {
        constructor(config?: RTCConfiguration) { super({ ...config, iceServers: [] }); pcs.push(this); }
      };
      Object.assign(window, { __cameraPcs: pcs, __denyCamera: false, __openedCameras: 0 });
      const devices = navigator.mediaDevices;
      const enumerate = devices.enumerateDevices.bind(devices);
      devices.enumerateDevices = async () => [
        ...(await enumerate()).filter(device => device.kind !== "videoinput"),
        ...["camera-a", "camera-b"].map((deviceId, index) => ({
          deviceId, kind: "videoinput", groupId: "test", label: `Тестовая камера ${index + 1}`, toJSON() { return this; },
        } as MediaDeviceInfo)),
      ];
      const capture = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async constraints => {
        if (!constraints?.video) return capture(constraints);
        const state = window as unknown as { __denyCamera: boolean; __openedCameras: number };
        if (state.__denyCamera) throw new DOMException("Test camera denied", "NotAllowedError");
        state.__openedCameras++;
        const video = typeof constraints.video === "object" ? constraints.video : {};
        const deviceId = video.deviceId && typeof video.deviceId === "object" && !Array.isArray(video.deviceId)
          ? video.deviceId.exact : "camera-a";
        const canvas = document.createElement("canvas");
        canvas.width = deviceId === "camera-b" ? 320 : 640;
        canvas.height = deviceId === "camera-b" ? 180 : 360;
        const paint = () => {
          const context = canvas.getContext("2d")!;
          context.fillStyle = deviceId === "camera-b" ? "#7344ad" : "#397dac";
          context.fillRect(0, 0, canvas.width, canvas.height);
        };
        paint();
        const timer = setInterval(paint, 100);
        const stream = canvas.captureStream(10);
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId: String(deviceId) });
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
        return stream;
      };
    });
    await login(caller, "artem", "Artem1234!");
    await login(receiver, "alice", "Alice1234!");
    await caller.getByRole("button", { name: "Люди", exact: true }).click();
    await caller.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@alice");
    await caller.getByRole("button", { name: /Алиса.*@alice/ }).click();
    await receiver.getByRole("button", { name: "Люди", exact: true }).click();
    await receiver.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@artem");
    await receiver.getByRole("button", { name: /Artem.*@artem/ }).click();
    await caller.getByRole("button", { name: "Звонок", exact: true }).click();
    await receiver.getByRole("button", { name: "Ответить", exact: true }).click();
    const choose = async (deviceId: string) => {
      await caller.getByRole("button", { name: "Выбрать камеру", exact: true }).click();
      await caller.getByRole("combobox", { name: "Камера", exact: true }).selectOption(deviceId);
    };
    const selected = () => caller.evaluate(() => localStorage.getItem("pulse-camera-device"));
    await caller.setViewportSize({ width: 390, height: 844 });
    await caller.getByRole("button", { name: "Выбрать камеру", exact: true }).click();
    await expect(caller.getByRole("dialog", { name: "Настройки камеры" })).toBeInViewport({ ratio: 1 });
    await expect(caller.getByRole("combobox", { name: "Камера", exact: true })).toBeEnabled();
    await caller.screenshot({ path: "test-results/camera-selector-mobile.png" });
    await caller.keyboard.press("Escape");
    await expect(caller.getByRole("dialog", { name: "Настройки камеры" })).toHaveCount(0);
    await caller.setViewportSize({ width: 1280, height: 720 });
    await choose("camera-b");
    expect(await caller.evaluate(() => (window as unknown as { __openedCameras: number }).__openedCameras)).toBe(0);
    await caller.getByRole("button", { name: "Включить камеру", exact: true }).click();
    const remoteWidth = () => receiver.locator(".call__tile:not(.call__tile--self) video").evaluate((video: HTMLVideoElement) => video.videoWidth);
    await expect.poll(remoteWidth).toBe(320);
    await caller.evaluate(() => {
      const pcs = (window as unknown as { __cameraPcs: RTCPeerConnection[] }).__cameraPcs;
      const pc = pcs.find(pc => pc.connectionState === "connected")!;
      Object.assign(window, { __previousCamera: pc.getSenders().find(sender => sender.track?.kind === "video")!.track,
        __previousMic: pc.getSenders().find(sender => sender.track?.kind === "audio")!.track });
    });
    await choose("camera-a");
    await expect.poll(selected).toBe("camera-a");
    await expect.poll(remoteWidth).toBe(640);
    expect(await caller.evaluate(() => {
      const state = window as unknown as { __cameraPcs: RTCPeerConnection[]; __previousCamera: MediaStreamTrack; __previousMic: MediaStreamTrack };
      const pc = state.__cameraPcs.find(pc => pc.connectionState === "connected")!;
      return { oldCamera: state.__previousCamera.readyState,
        camera: pc.getSenders().find(sender => sender.track?.kind === "video")?.track?.getSettings().deviceId,
        sameMic: pc.getSenders().find(sender => sender.track?.kind === "audio")?.track === state.__previousMic };
    })).toEqual({ oldCamera: "ended", camera: "camera-a", sameMic: true });
    await expect(caller.locator(".call__tile.has-video .call__tile-name").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await caller.evaluate(() => Object.assign(window, { __denyCamera: true }));
    await choose("camera-b");
    await expect(caller.getByRole("button", { name: "Выключить камеру", exact: true })).toBeEnabled();
    expect(await selected()).toBe("camera-a");
    expect(await remoteWidth()).toBe(640);
    await caller.evaluate(() => Object.assign(window, { __denyCamera: false }));
    await caller.getByRole("button", { name: "Выключить камеру", exact: true }).click();
    await caller.getByRole("button", { name: "Включить камеру", exact: true }).click();
    await expect.poll(remoteWidth).toBe(640);
    expect(await selected()).toBe("camera-a");
    await caller.getByRole("button", { name: /^Завершить(?: звонок)?$/ }).click();
  } finally { await a.close(); await b.close(); }
});

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
        const cancelled = (window as unknown as { __captureCancellation?: string }).__captureCancellation;
        if (cancelled) throw new DOMException("Test capture cancelled", cancelled);
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
    await caller.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@alice");
    await caller.getByRole("button", { name: /Алиса.*@alice/ }).click();
    await receiver.getByRole("button", { name: "Люди", exact: true }).click();
    await receiver.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@artem");
    await receiver.getByRole("button", { name: /Artem.*@artem/ }).click();
    await caller.getByRole("button", { name: "Звонок", exact: true }).click();
    await receiver.getByRole("button", { name: "Ответить", exact: true }).click();
    await expect.poll(() => caller.evaluate(() =>
      (window as unknown as { __audioPcs: RTCPeerConnection[] }).__audioPcs.some(pc => pc.connectionState === "connected"))).toBe(true);
    await expect(caller.locator(".connection-signal").first()).toHaveText(/Пинг: \d+ мс/);
    for (const name of ["AbortError", "NotAllowedError"]) {
      await caller.evaluate(name => Object.assign(window, { __captureCancellation: name }), name);
      await caller.getByRole("button", { name: "Демонстрация экрана", exact: true }).click();
      await expect(caller.getByRole("button", { name: "Демонстрация экрана", exact: true })).toBeEnabled();
      await expect(caller.getByText(/Демонстрация экрана (недоступна|отклонена)/)).toHaveCount(0);
    }
    await caller.evaluate(() => Object.assign(window, { __captureCancellation: "" }));
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
      await expect(caller.locator(".screen-audio-visualizer")).toHaveAttribute("data-audio-active", "true");
      await expect(receiver.locator(".screen-audio-visualizer")).toHaveAttribute("data-audio-active", "true");
      const sections = await caller.evaluate(() => {
        const pcs = (window as unknown as { __audioPcs: RTCPeerConnection[] }).__audioPcs;
        return (pcs.find(pc => pc.connectionState === "connected")?.localDescription?.sdp.match(/^m=audio /gm) || []).length;
      });
      audioSections ??= sections;
      expect(sections).toBe(2);
      expect(sections).toBe(audioSections);
      if (i === 0) {
        // Exercise the hook's cache: both tiers keep the same resolution label.
        await caller.evaluate(() => {
          const pc = (window as unknown as { __audioPcs: RTCPeerConnection[] }).__audioPcs
            .find(item => item.connectionState === "connected")!;
          const original = pc.getStats.bind(pc);
          const state = { bitrate: 1_500_000, hidden: false };
          Object.assign(window, { __qualityState: state, __restoreQualityStats: () => {
            pc.getStats = original;
            Reflect.deleteProperty(document, "visibilityState");
          } });
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state.hidden ? "hidden" : "visible" });
          pc.getStats = async () => new Map([["pair", { id: "pair", type: "candidate-pair", state: "succeeded",
            nominated: true, currentRoundTripTime: 0.02, availableOutgoingBitrate: state.bitrate }]]) as RTCStatsReport;
        });
        const screenEncoding = () => caller.evaluate(() => {
          const pc = (window as unknown as { __audioPcs: RTCPeerConnection[] }).__audioPcs
            .find(item => item.connectionState === "connected")!;
          const params = pc.getSenders().find(sender => sender.track?.contentHint === "detail")?.getParameters().encodings[0];
          return { bitrate: params?.maxBitrate, fps: params?.maxFramerate };
        });
        try {
          await expect.poll(screenEncoding).toEqual({ bitrate: 3000000, fps: 15 });
          await caller.evaluate(() => {
            const state = (window as unknown as { __qualityState: { bitrate: number; hidden: boolean } }).__qualityState;
            state.bitrate = 25_000_000;
            state.hidden = true;
          });
          await expect.poll(screenEncoding).toEqual({ bitrate: 8000000, fps: 30 });
        } finally {
          await caller.evaluate(() => (window as unknown as { __restoreQualityStats(): void }).__restoreQualityStats());
        }
      }
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
    await caller.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@alice");
    await caller.getByRole("button", { name: /Алиса.*@alice/ }).click();
    await receiver.getByRole("button", { name: "Люди", exact: true }).click();
    await receiver.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@artem");
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
    await caller.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@alice");
    await caller.getByRole("button", { name: /Алиса.*@alice/ }).click();
    await receiver.getByRole("button", { name: "Люди", exact: true }).click();
    await receiver.getByRole("textbox", { name: "Поиск людей и групп" }).fill("@artem");
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
