import { expect, test } from "@playwright/test";
import { build } from "esbuild";

let bundle: string;
test.use({ channel: "msedge" });
test.beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { createElement, useEffect } from 'react';
      import { createRoot } from 'react-dom/client';
      import { useVoiceChannel } from './src/hooks/useVoiceChannel';
      import { peekMediaResume } from './src/lib/mediaResume';
      const handlers = new Map();
      export const socket = {
        connected: true,
        on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
        off(event, fn) { handlers.get(event)?.delete(fn); },
        emit(event, ...args) {
          if (event === 'voice:join') {
            socket.joins = (socket.joins || 0) + 1;
            args.at(-1)({ ok: true, peers: [] });
          }
          if (event === 'voice:leave') socket.leaves = (socket.leaves || 0) + 1;
        }
      };
      export function event(name, payload) { for (const fn of handlers.get(name) || []) fn(payload); }
      export let voice;
      function App() {
        voice = useVoiceChannel({ socket, selfId: 'self', token: 'test' });
        useEffect(() => {
          const saved = peekMediaResume();
          if (saved?.kind === 'voice') void voice.join(saved.channelId, saved.groupId, saved.title);
        }, []);
        return createElement('div', null, voice.active ? 'active' : 'idle');
      }
      export function mount() { createRoot(document.body.appendChild(document.createElement('main'))).render(createElement(App)); }
      export function view() { return { active: voice?.active, joining: voice?.joining, error: voice?.error, saved: peekMediaResume(), leaves: socket.leaves || 0 }; }
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "voiceTest",
    plugins: [{ name: "controlled-sfu", setup(builder) {
      builder.onResolve({ filter: /useVoiceChannelLiveKit$/ }, () => ({ path: "sfu", namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ resolveDir: process.cwd(), contents: `
        import { useCallback, useRef, useState } from 'react';
        export function useVoiceChannelLiveKit() {
          const [state, setState] = useState({ joining: false, room: false, muted: false, deafened: false, cameraOff: true, linkPhase: null });
          const room = useRef(false);
          const hasRoom = useCallback(() => room.current, []);
          const startMedia = useCallback(async (id, group, title, peers, controls) => {
            setState(s => ({ ...s, joining: true }));
            await new Promise((resolve, reject) => { window.finishVoiceMedia = (fail) => fail ? reject(new Error('SFU unavailable')) : resolve(); });
            room.current = true;
            setState(s => ({ ...s, ...controls, joining: false, room: true }));
          }, []);
          const stopMedia = useCallback(() => { room.current = false; setState(s => ({ ...s, joining: false, room: false, linkPhase: null })); }, []);
          const setMinimized = useCallback(() => {}, []);
          window.failVoiceLink = () => setState(s => ({ ...s, linkPhase: 'failed' }));
          return { ...state, startMedia, stopMedia, setMinimized, hasRoom,
            prepareSwitch: async () => {}, setPeersExternal: () => {}, clearError: () => {}, peers: [] };
        }
      ` }));
    } }],
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route("**/voice-resume-harness", route => route.fulfill({ contentType: "text/html", body: "<title>Voice resume regression</title>" }));
  await page.goto("/voice-resume-harness");
  await page.addScriptTag({ content: bundle });
});

const savedVoice = { kind: "voice", channelId: "channel", groupId: "group", title: "Общий", muted: true, deafened: true, cameraOff: false };

test("reload keeps saved controls until media is connected", async ({ page }) => {
  await page.evaluate(saved => sessionStorage.setItem("pulse-media-resume", JSON.stringify({ ...saved, at: Date.now() })), savedVoice);
  await page.reload();
  await page.addScriptTag({ content: bundle });
  await page.evaluate("voiceTest.mount()");
  await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(true);
  expect(await page.evaluate("voiceTest.view().saved")).toMatchObject(savedVoice);
  await page.evaluate("window.finishVoiceMedia(false)");
  await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(false);
  expect(await page.evaluate("voiceTest.view().saved")).toMatchObject(savedVoice);
});

for (const reason of ["failure", "takeover", "missing membership", "lost media"] as const) {
  test(`${reason} clears presence and prevents resurrection on reload`, async ({ page }) => {
    await page.evaluate(saved => sessionStorage.setItem("pulse-media-resume", JSON.stringify({ ...saved, at: Date.now() })), savedVoice);
    await page.evaluate("voiceTest.mount()");
    await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(true);
    if (reason === "failure") {
      await page.evaluate("window.finishVoiceMedia(true)");
    } else if (reason === "takeover") {
      await page.evaluate("voiceTest.event('voice:kick', {channelId:'channel', reason:'takeover'}); window.finishVoiceMedia(false)");
    } else {
      await page.evaluate("window.finishVoiceMedia(false)");
      await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(false);
      if (reason === "missing membership") await page.evaluate("voiceTest.event('voice:state', {groupId:'group', channels:[{id:'channel', users:[]}]})");
      else await page.evaluate("window.failVoiceLink()");
    }
    await expect.poll(() => page.evaluate("voiceTest.view().active")).toBeNull();
    await expect.poll(() => page.evaluate("voiceTest.view().saved")).toBeNull();
    await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(false);
    await page.reload();
    await page.addScriptTag({ content: bundle });
    await page.evaluate("voiceTest.mount()");
    await expect(page.locator("main")).toHaveText("idle");
    expect(await page.evaluate("voiceTest.socket.joins || 0")).toBe(0);
  });
}

test("a retry from an old connection cannot rejoin after leaving", async ({ page }) => {
  await page.clock.install();
  await page.evaluate("voiceTest.mount()");
  await expect(page.locator("main")).toHaveText("idle");
  await page.evaluate("void voiceTest.voice.join('channel', 'group', 'Общий')");
  await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(true);
  await page.evaluate("window.finishVoiceMedia(false)");
  await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(false);
  await page.evaluate(`
    const emit = voiceTest.socket.emit.bind(voiceTest.socket);
    voiceTest.socket.emit = (event, ...args) => {
      if (event === 'voice:join') { window.rejoinAck = args.at(-1); return; }
      emit(event, ...args);
    };
    voiceTest.event('connect');
    voiceTest.event('voice:state', {groupId:'group', channels:[{id:'channel', users:[]}]});
  `);
  expect(await page.evaluate("voiceTest.view().active")).not.toBeNull();
  await page.clock.fastForward(100);
  await page.evaluate("window.rejoinAck({ok:false, error:'Сначала войдите в аккаунт'}); voiceTest.voice.leave()");
  await page.clock.fastForward(600);
  expect(await page.evaluate("voiceTest.view().active")).toBeNull();
  expect(await page.evaluate("voiceTest.view().saved")).toBeNull();
  expect(await page.evaluate("voiceTest.socket.joins")).toBe(1);
});

test("a reconnect without an acknowledgement times out and clears the session", async ({ page }) => {
  await page.clock.install();
  await page.evaluate("voiceTest.mount()");
  await expect(page.locator("main")).toHaveText("idle");
  await page.evaluate("void voiceTest.voice.join('channel', 'group', 'Общий')");
  await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(true);
  await page.evaluate("window.finishVoiceMedia(false)");
  await expect.poll(() => page.evaluate("voiceTest.view().joining")).toBe(false);
  await page.evaluate(`
    const emit = voiceTest.socket.emit.bind(voiceTest.socket);
    voiceTest.socket.emit = (event, ...args) => { if (event !== 'voice:join') emit(event, ...args); };
    voiceTest.event('connect');
  `);
  await page.clock.fastForward(100);
  await page.clock.fastForward(10_000);
  await expect.poll(() => page.evaluate("voiceTest.view().active")).toBeNull();
  expect(await page.evaluate("voiceTest.view().saved")).toBeNull();
  expect(await page.evaluate("voiceTest.view().error")).toContain("Сервер не ответил");
});
