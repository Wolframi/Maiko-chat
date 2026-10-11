import { expect, test } from "@playwright/test";
import { build } from "esbuild";

declare global {
  interface Window {
    screenAudioTest: typeof import("../src/lib/webrtcMedia");
  }
}

let bundle: string;
test.use({ channel: "msedge" });

test.beforeAll(async () => {
  const result = await build({
    entryPoints: ["src/lib/webrtcMedia.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "screenAudioTest",
    platform: "browser",
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route("**/screen-audio-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Screen audio test</title>" }),
  );
  await page.goto("http://127.0.0.1:3000/screen-audio-test");
  await page.addScriptTag({ content: bundle });
});

const cases = [
  { name: "keeps isolated system audio", surface: "monitor", supported: true, initial: true, result: "ignored", keep: true },
  { name: "keeps full-screen audio without requiring isolation", surface: "monitor", supported: true, initial: false, result: "applied", keep: true },
  { name: "keeps full-screen audio even when isolation would reject", surface: "monitor", supported: true, initial: false, result: "rejected", keep: true },
  { name: "keeps full-screen audio when the browser ignores isolation", surface: "monitor", supported: true, initial: false, result: "ignored", keep: true },
  { name: "keeps Windows 10 full-screen audio without the isolation feature", surface: "monitor", supported: false, initial: false, result: "ignored", keep: true },
  { name: "drops window loopback when isolation is unavailable", surface: "window", supported: false, initial: false, result: "ignored", keep: false },
  { name: "keeps another tab's content audio on older browsers", surface: "browser", supported: false, initial: false, result: "ignored", keep: true },
  { name: "offers and keeps system audio without the global feature flag", surface: "monitor", supported: false, initial: false, result: "applied", keep: true },
  { name: "keeps isolated window audio", surface: "window", supported: true, initial: false, result: "applied", keep: true },
  { name: "drops window audio when isolation rejects", surface: "window", supported: true, initial: false, result: "rejected", keep: false },
  { name: "drops window audio when the browser ignores isolation", surface: "window", supported: true, initial: false, result: "ignored", keep: false },
  { name: "rejects audio from a Mayko tab playing a call", surface: "browser", supported: true, initial: true, result: "ignored", keep: false, callTab: true },
  { name: "does not trust an unknown capture source", surface: undefined, supported: false, initial: false, result: "ignored", keep: false },
  { name: "keeps full-screen audio returned by the compatibility fallback", surface: "monitor", supported: true, initial: false, result: "ignored", keep: true, fallback: true },
  { name: "isolates window audio returned by the compatibility fallback", surface: "window", supported: true, initial: false, result: "ignored", keep: false, fallback: true },
] as const;

for (const scenario of cases) {
  test(scenario.name, async ({ page }) => {
    const result = await page.evaluate(async (scenario) => {
      const ctx = new AudioContext();
      const audio = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
      const video = document.createElement("canvas").captureStream().getVideoTracks()[0];
      const stream = new MediaStream([video, audio]);
      let restricted = scenario.initial;
      let applied = false;
      const warnings: string[] = [];
      let config: { handle?: string; exposeOrigin?: boolean; permittedOrigins?: string[] } = {};
      Object.defineProperty(navigator.mediaDevices, "setCaptureHandleConfig", {
        value: (value: typeof config) => { config = value; },
      });
      window.screenAudioTest.configureCallAudioCapture(true);
      Object.defineProperty(video, "getCaptureHandle", {
        value: () => "callTab" in scenario && scenario.callTab
          ? { handle: config.handle, origin: location.origin }
          : null,
      });
      const requests: (DisplayMediaStreamOptions & {
        systemAudio?: string;
        windowAudio?: string;
        selfBrowserSurface?: string;
        monitorTypeSurfaces?: string;
        surfaceSwitching?: string;
      })[] = [];
      Object.defineProperty(video, "getSettings", {
        value: () => ({ displaySurface: scenario.surface }),
      });
      Object.defineProperty(audio, "getSettings", {
        value: () => ({ restrictOwnAudio: restricted }),
      });
      Object.defineProperty(audio, "applyConstraints", {
        value: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          applied = true;
          if (scenario.result === "rejected") {
            throw new DOMException("Cannot isolate", "OverconstrainedError");
          }
          if (scenario.result === "applied") restricted = true;
        },
      });
      Object.defineProperty(navigator.mediaDevices, "getSupportedConstraints", {
        value: () => ({ restrictOwnAudio: scenario.supported }),
      });
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        value: async (options: DisplayMediaStreamOptions) => {
          requests.push(options);
          if ("fallback" in scenario && scenario.fallback && requests.length === 1) {
            throw new TypeError("Unsupported audio options");
          }
          return stream;
        },
      });
      try {
        const captured = await window.screenAudioTest.captureScreenShare({
          onAudioUnavailable: (message) => warnings.push(message),
        });
        return {
          audioCount: captured.getAudioTracks().length,
          audioState: audio.readyState,
          videoState: video.readyState,
          applied,
          requests,
          warnings,
          config,
        };
      } finally {
        stream.getTracks().forEach((track) => track.stop());
        await ctx.close();
      }
    }, scenario);

    expect(result.audioCount).toBe(scenario.keep ? 1 : 0);
    expect(result.audioState).toBe(scenario.keep ? "live" : "ended");
    expect(result.videoState).toBe("live");
    expect(result.applied).toBe(scenario.surface !== "browser" && scenario.surface !== "monitor" && !scenario.initial);
    expect(result.warnings).toHaveLength(scenario.keep ? 0 : 1);
    if (!scenario.keep) expect(result.warnings[0]).toMatch(/(голоса|эхо)/);
    expect(result.config.permittedOrigins).toEqual(["http://127.0.0.1:3000"]);
    expect(result.requests).toHaveLength("fallback" in scenario ? 2 : 1);
    for (const request of result.requests) {
      expect(request.systemAudio).toBe("include");
      expect(request.windowAudio).toBe("window");
      expect(request.selfBrowserSurface).toBe("exclude");
      expect(request.monitorTypeSurfaces).toBe("include");
      expect(request.surfaceSwitching).toBe("exclude");
      expect(request.video).toMatchObject({ displaySurface: "monitor" });
    }
  });
}

test("stops tab audio if the shared tab joins a call later", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ctx = new AudioContext();
    const audio = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    const video = document.createElement("canvas").captureStream().getVideoTracks()[0];
    const stream = new MediaStream([video, audio]);
    let config: { handle?: string; permittedOrigins?: string[] } = {};
    const warnings: string[] = [];
    Object.defineProperty(navigator.mediaDevices, "setCaptureHandleConfig", {
      value: (value: typeof config) => { config = value; },
    });
    Object.defineProperty(video, "getSettings", { value: () => ({ displaySurface: "browser" }) });
    Object.defineProperty(video, "getCaptureHandle", {
      value: () => config.handle ? { handle: config.handle, origin: location.origin } : null,
    });
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: async () => stream });
    try {
      const captured = await window.screenAudioTest.captureScreenShare({
        onAudioUnavailable: (message) => warnings.push(message),
      });
      const before = captured.getAudioTracks().length;
      window.screenAudioTest.configureCallAudioCapture(true);
      video.dispatchEvent(new Event("capturehandlechange"));
      const after = captured.getAudioTracks().length;
      window.screenAudioTest.configureCallAudioCapture(false);
      video.dispatchEvent(new Event("capturehandlechange"));
      return { before, after, audioState: audio.readyState, videoState: video.readyState, config, warnings };
    } finally {
      stream.getTracks().forEach((track) => track.stop());
      await ctx.close();
    }
  });
  expect(result.before).toBe(1);
  expect(result.after).toBe(0);
  expect(result.audioState).toBe("ended");
  expect(result.videoState).toBe("live");
  expect(result.config).toEqual({});
  expect(result.warnings).toHaveLength(1);
});

test("does not reopen the picker after cancellation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let requests = 0;
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      value: async () => {
        requests++;
        throw new DOMException("Cancelled", "NotAllowedError");
      },
    });
    try {
      await window.screenAudioTest.captureScreenShare();
      return { requests, error: null };
    } catch (error) {
      return { requests, error: (error as DOMException).name };
    }
  });
  expect(result).toEqual({ requests: 1, error: "NotAllowedError" });
});
