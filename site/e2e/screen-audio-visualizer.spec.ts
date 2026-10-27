import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

test.use({
  channel: "msedge",
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

let bundle: string;
let frameBundle: string;
let css: string;
test.beforeAll(async () => {
  css = await readFile("src/app/styles/call-stage.css", "utf8");
  const result = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ScreenShareStage } from './src/components/chat/ScreenShareStage';
      import { withScreenAudioTracks } from './src/lib/screenAudioSignal';
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      oscillator.start();
      const gains = {};
      const audioTracks = {};
      const media = {};
      const videoTracks = [];
      const destinations = {};
      for (const id of ['a', 'b']) {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        canvas.getContext('2d').fillRect(0, 0, 640, 360);
        const video = canvas.captureStream(1).getVideoTracks()[0];
        video.contentHint = 'detail';
        videoTracks.push(video);
        const gain = context.createGain();
        gain.gain.value = id === 'a' ? 0.2 : 0;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain); gain.connect(destination);
        gains[id] = gain; destinations[id] = destination;
        const track = destination.stream.getAudioTracks()[0];
        audioTracks[id] = track;
        // The parent stream can contain a loud mic. Only explicitly routed
        // screen audio is allowed to drive each visualizer.
        const micDestination = context.createMediaStreamDestination();
        oscillator.connect(micDestination);
        const mic = micDestination.stream.getAudioTracks()[0];
        media[id] = withScreenAudioTracks(new MediaStream([video, mic]), [track]);
      }
      const root = createRoot(document.getElementById('root'));
      root.render(<React.StrictMode><ScreenShareStage sources={['a', 'b'].map(id => ({
        id, label: id, local: id === 'a', kind: 'screen',
        stream: new MediaStream([videoTracks[id === 'a' ? 0 : 1]]), audioStream: media[id],
      }))} /></React.StrictMode>);
      window.signalHarness = {
        setLevel: (id, value) => { gains[id].gain.value = value; },
        enable: (id, value) => { audioTracks[id].enabled = value; },
        replace: id => {
          const next = context.createMediaStreamDestination();
          gains[id].disconnect(); gains[id].connect(next);
          audioTracks[id].stop();
          audioTracks[id] = next.stream.getAudioTracks()[0];
          withScreenAudioTracks(media[id], [audioTracks[id]]);
        },
        end: id => audioTracks[id].stop(),
        unmount: () => { root.unmount(); return audioTracks.a.readyState; },
      };
      context.resume();
    `, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  });
  bundle = result.outputFiles[0].text;
  const frame = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ScreenAudioVisualizer } from './src/components/chat/ScreenAudioVisualizer';
      createRoot(document.getElementById('root')).render(<React.StrictMode>
        <ScreenAudioVisualizer stream={window.parent.signalStream} />
      </React.StrictMode>);
    `, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  });
  frameBundle = frame.outputFiles[0].text;
});

test("each share visualizes only its screen signal and follows silence, replacement and cleanup", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.route("**/screen-signal-harness", (route) => route.fulfill({
    contentType: "text/html", body: `<style>${css}
      body { margin: 0; background: #121216; }
      .call__screens { display: flex; gap: 16px; padding: 16px; box-sizing: border-box; }
      .call__screen-pane { height: 260px; width: 420px; flex: none; }
      @media(max-width:640px) { .call__screens { flex-direction: column; } .call__screen-pane { width: 100%; height: 220px; } }
      </style><div id="root"></div>`,
  }));
  await page.goto("/screen-signal-harness");
  await page.addScriptTag({ content: bundle });
  const visualizer = (id: string) => page.locator(`[data-call-tile-id="${id}"] .screen-audio-visualizer`);
  const change = (method: string, id: string, value?: number | boolean) => page.evaluate(
    ({ method, id, value }) => {
      const harness = (window as unknown as { signalHarness: Record<string, (...args: unknown[]) => void> }).signalHarness;
      harness[method](id, value);
    }, { method, id, value },
  );

  await expect(visualizer("a")).toHaveAttribute("data-audio-active", "true");
  await expect(visualizer("b")).toHaveAttribute("data-audio-active", "false");
  await expect(visualizer("a")).toHaveText("");
  await expect(visualizer("a").locator("canvas")).toBeVisible();
  await expect(visualizer("a")).toHaveAttribute("data-renderer", "webgl");
  const soundingBlob = await visualizer("a").locator("canvas").screenshot();
  await change("setLevel", "b", 0.25);
  await expect(visualizer("b")).toHaveAttribute("data-audio-active", "true");
  await change("setLevel", "a", 0);
  await expect(visualizer("a")).toHaveAttribute("data-audio-active", "false");
  const silentBlob = await visualizer("a").locator("canvas").screenshot();
  expect(soundingBlob.equals(silentBlob)).toBe(false);
  await change("enable", "b", false);
  await expect(visualizer("b")).toHaveAttribute("data-audio-active", "false");
  await change("enable", "b", true);
  await expect(visualizer("b")).toHaveAttribute("data-audio-active", "true");
  await change("replace", "b");
  await expect(visualizer("b")).toHaveAttribute("data-audio-active", "true");
  await change("end", "b");
  await expect(visualizer("b")).toHaveAttribute("data-audio-active", "false");
  await change("setLevel", "a", 0.2);
  await expect(visualizer("a")).toHaveAttribute("data-audio-active", "true");
  await page.screenshot({ path: "test-results/screen-audio-visualizer-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(visualizer("a")).toBeVisible();
  for (const id of ["a", "b"]) {
    const bounds = (await visualizer(id).boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  }
  await page.screenshot({ path: "test-results/screen-audio-visualizer-mobile.png" });
  const remainingTrackState = await page.evaluate(() =>
    (window as unknown as { signalHarness: { unmount: () => string } }).signalHarness.unmount());
  expect(remainingTrackState).toBe("live");
  expect(errors).toEqual([]);
});

test.describe("desktop media owner", () => {
  test("a reloaded UI measures the owner's own share without another click inside the iframe", async ({ playwright, baseURL }) => {
    const browser = await playwright.chromium.launch({ channel: "msedge",
      args: ["--autoplay-policy=document-user-activation-required"] });
    try {
    const page = await browser.newPage({ baseURL });
    await page.route("**/signal-owner", route => route.fulfill({ contentType: "text/html", body: `
      <button id="start">Start screen audio in media owner</button><iframe id="ui" allow="autoplay" src="/signal-ui"></iframe>
    ` }));
    await page.route("**/signal-ui", route => route.fulfill({ contentType: "text/html", body: `<style>${css}</style><div id="root"></div>` }));
    await page.goto("/signal-owner");
    await page.evaluate(() => {
      const owner = window as unknown as {
        signalStream: MediaStream;
        signalGain: GainNode;
        maikoMediaRuntime: { version: number };
      };
      owner.signalStream = new MediaStream();
      owner.maikoMediaRuntime = { version: 1 };
      document.getElementById("start")!.onclick = async () => {
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.2;
        const output = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(output);
        oscillator.start();
        owner.signalGain = gain;
        Object.defineProperty(owner.signalStream, Symbol.for("mayko.screen-audio-tracks"), {
          configurable: true, value: output.stream.getAudioTracks(),
        });
      };
    });
    await page.getByRole("button", { name: "Start screen audio in media owner" }).click();
    const frame = page.frames().find(frame => frame.url().endsWith("/signal-ui"))!;
    await frame.addScriptTag({ content: frameBundle });
    const indicator = frame.locator(".screen-audio-visualizer");
    await expect(indicator).toHaveAttribute("data-audio-active", "true", { timeout: 4_000 });
    await page.evaluate(() => {
      (window as unknown as { signalGain: GainNode }).signalGain.gain.value = 0;
    });
    await expect(indicator).toHaveAttribute("data-audio-active", "false");
    } finally { await browser.close(); }
  });
});
