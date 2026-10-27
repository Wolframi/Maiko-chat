import { expect, test } from "@playwright/test";
import { build } from "esbuild";

type Counts = Record<string, number>;
type Harness = { counts(): Counts; subscriptions(): number; callBurst(): void; typing(): void; draft(): void; edit(): void; unmount(): void };
declare global {
  interface Window {
    harness: Harness;
    runtimeHarness: { counts(): Counts; tick(): void; message(): void; rename(): void; unmount(): void };
  }
}

test.use({ channel: "msedge" });

test("selectors isolate call ticks, typing, drafts and messages and survive selector changes and unmount", async ({ page }) => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React, { memo, StrictMode, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { createExternalStore, shallowEqual } from './src/lib/externalStore';
    import { useStoreSelector } from './src/hooks/useStoreSelector';
    const message = createExternalStore({ text: 'first', draft: '', typing: false }, shallowEqual);
    const list = createExternalStore({ preview: 'first' }, shallowEqual);
    const call = createExternalStore({ tick: 0, speaking: false }, shallowEqual);
    const counts = { thread: 0, composer: 0, typing: 0, sidebar: 0, call: 0 };
    let subscriptions = 0;
    for (const store of [message, list, call]) {
      const subscribe = store.subscribe;
      store.subscribe = listener => { subscriptions++; const stop = subscribe(listener); return () => { subscriptions--; stop(); }; };
    }
    const Thread = memo(() => { const value = useStoreSelector(message, state => ({ text: state.text }), shallowEqual); counts.thread++; return <p id="thread">{value.text}</p>; });
    const Composer = memo(() => { const draft = useStoreSelector(message, state => state.draft); counts.composer++; return <p id="composer">{draft}</p>; });
    const Typing = memo(() => { const typing = useStoreSelector(message, state => state.typing); counts.typing++; return <p id="typing">{String(typing)}</p>; });
    const Sidebar = memo(() => { const preview = useStoreSelector(list, state => state.preview); counts.sidebar++; return <p id="sidebar">{preview}</p>; });
    const Call = memo(() => { const state = useStoreSelector(call, state => state); counts.call++; return <p id="call">{state.tick}:{String(state.speaking)}</p>; });
    function Root() {
      const [field, setField] = useState('text');
      const selected = useStoreSelector(message, state => ({ value: state[field] }), shallowEqual);
      return <><Thread/><Composer/><Typing/><Sidebar/><Call/>
        <p id="selection">{selected.value}</p><button onClick={() => setField(field === 'text' ? 'draft' : 'text')}>Change selector</button></>;
    }
    const root = createRoot(document.getElementById('root'));
    root.render(<StrictMode><Root/></StrictMode>);
    window.harness = {
      counts: () => ({ ...counts }), subscriptions: () => subscriptions,
      callBurst() { for (let tick = 1; tick <= 100; tick++) call.publish({ tick, speaking: tick % 2 === 0 }); },
      typing() { message.publish({ ...message.getSnapshot(), typing: true }); },
      draft() { message.publish({ ...message.getSnapshot(), draft: 'draft' }); },
      edit() { message.publish({ ...message.getSnapshot(), text: 'edited' }); list.publish({ preview: 'edited' }); },
      unmount() { root.unmount(); },
    };
  ` }, bundle: true, write: false, platform: "browser", jsx: "automatic" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/state-harness", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1:3000/state-harness");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect(page.locator("#thread")).toHaveText("first");
  const counts = () => page.evaluate(() => window.harness.counts());
  const perform = (action: Exclude<keyof Harness, "counts" | "subscriptions">) => page.evaluate(action => window.harness[action](), action);
  const initial = await counts();
  await perform("callBurst"); await expect(page.locator("#call")).toHaveText("100:true");
  const afterCall = await counts();
  for (const key of ["thread", "composer", "typing", "sidebar"]) expect(afterCall[key]).toBe(initial[key]);
  expect(afterCall.call).toBeGreaterThan(initial.call);
  await perform("typing"); await expect(page.locator("#typing")).toHaveText("true");
  expect((await counts()).thread).toBe(initial.thread);
  expect((await counts()).sidebar).toBe(initial.sidebar);
  await perform("draft"); await expect(page.locator("#composer")).toHaveText("draft");
  expect((await counts()).thread).toBe(initial.thread);
  await page.getByRole("button", { name: "Change selector" }).click();
  await expect(page.locator("#selection")).toHaveText("draft");
  await perform("edit");
  await expect(page.locator("#thread")).toHaveText("edited");
  await expect(page.locator("#sidebar")).toHaveText("edited");
  await expect(page.locator("#selection")).toHaveText("draft");
  expect(await page.evaluate(() => window.harness.subscriptions())).toBe(6);
  await perform("unmount");
  expect(await page.evaluate(() => window.harness.subscriptions())).toBe(0);
  await perform("callBurst");
  expect(errors).toEqual([]);
});

test("runtime partitions keep the workspace and composer idle during call and voice activity", async ({ page }) => {
  const bundle = await build({
    plugins: [{ name: "media-and-chat-fixtures", setup(builder) {
      builder.onLoad({ filter: /[\\/]hooks[\\/](useChat|useCall|useVoiceChannel)\.ts$/ }, args => {
        const hook = args.path.match(/(useChat|useCall|useVoiceChannel)\.ts$/)![1];
        const field = hook === "useChat" ? "chat" : hook === "useCall" ? "call" : "voice";
        return { loader: "js", contents: `import { useSyncExternalStore } from 'react';
          export function ${hook}() { const fixture = window.runtimeFixture;
            return useSyncExternalStore(fixture.subscribe, fixture.getSnapshot, fixture.getSnapshot).${field}; }` };
      });
    } }],
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React, { memo, StrictMode } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChatRuntimeProvider, ChatRuntimeReady, useChatShell, useCallShell, useVoiceShell, useRuntimeState } from './src/components/chat/ChatRuntime';
      const group = { id: 'group', type: 'group', title: 'Group', topic: '', members: 1, memberIds: ['self'], textChannels: [], voiceChannels: [] };
      let snapshot = {
        chat: { session: null, account: null, socket: null, chats: [group], currentChat: group, unreadTotal: 0,
          messages: ['first'], historyLoading: false, historyVersion: 0, othersTyping: [], composerError: '' },
        call: { durationLabel: '0', localSpeaking: false },
        voice: { peers: [], selfSpeaking: false },
      };
      const listeners = new Set();
      window.runtimeFixture = { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => snapshot };
      const publish = next => { snapshot = next; listeners.forEach(listener => listener()); };
      const counts = { workspace: 0, thread: 0, composer: 0, sidebar: 0, call: 0 };
      const Thread = memo(() => { const messages = useRuntimeState('conversation', state => state.messages); counts.thread++; return <p id="thread">{messages.join(',')}</p>; });
      const Composer = memo(({ members }) => { const disabled = useRuntimeState('conversation', state => state.historyLoading && !state.messages.length); counts.composer++; return <p id="composer">{members.join(',')}:{String(disabled)}</p>; });
      const Sidebar = memo(() => { const chats = useRuntimeState('list', state => state.chats); counts.sidebar++; return <p id="sidebar">{chats[0].voiceChannels[0]?.users[0]?.speaking ? 'speaking' : 'silent'}</p>; });
      const Call = memo(() => { const label = useRuntimeState('call', state => state.durationLabel); counts.call++; return <p id="call">{label}</p>; });
      function Workspace() {
        const chat = useChatShell(); useCallShell(); useVoiceShell(); counts.workspace++;
        return <><p id="title">{chat.currentChat.title}</p><Thread/><Composer members={chat.currentChat.memberIds}/><Sidebar/><Call/></>;
      }
      const root = createRoot(document.getElementById('root'));
      root.render(<StrictMode><ChatRuntimeProvider><ChatRuntimeReady><Workspace/></ChatRuntimeReady></ChatRuntimeProvider></StrictMode>);
      let ticks = 0;
      window.runtimeHarness = {
        counts: () => ({ ...counts }),
        tick() {
          ticks++;
          const group = { ...snapshot.chat.chats[0], memberIds: ['self'], textChannels: [],
            voiceChannels: [{ id: 'voice', title: 'Voice', users: [{ userId: 'self', speaking: ticks % 2 === 1 }] }] };
          publish({ chat: { ...snapshot.chat, chats: [group], currentChat: group },
            call: { ...snapshot.call, durationLabel: String(ticks), localSpeaking: ticks % 2 === 1 },
            voice: { ...snapshot.voice, selfSpeaking: ticks % 2 === 1, peers: [{ cameraOff: true, sharingScreen: false, speaking: ticks % 2 === 1 }] } });
        },
        message() { publish({ ...snapshot, chat: { ...snapshot.chat, messages: ['first', 'second'] } }); },
        rename() {
          const group = { ...snapshot.chat.chats[0], title: 'Renamed', memberIds: ['self', 'peer'], members: 2 };
          publish({ ...snapshot, chat: { ...snapshot.chat, chats: [group], currentChat: group } });
        },
        unmount() { root.unmount(); },
      };
    ` }, bundle: true, write: false, platform: "browser", jsx: "automatic",
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/runtime-harness", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://127.0.0.1:3000/runtime-harness");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect(page.locator("#thread")).toHaveText("first");
  const initial = await page.evaluate(() => window.runtimeHarness.counts());
  for (let tick = 1; tick <= 20; tick++) {
    await page.evaluate(() => window.runtimeHarness.tick());
    await expect(page.locator("#call")).toHaveText(String(tick));
    await expect(page.locator("#sidebar")).toHaveText(tick % 2 === 1 ? "speaking" : "silent");
  }
  const afterTicks = await page.evaluate(() => window.runtimeHarness.counts());
  for (const key of ["workspace", "thread", "composer"]) expect(afterTicks[key]).toBe(initial[key]);
  expect(afterTicks.call).toBeGreaterThan(initial.call);
  expect(afterTicks.sidebar).toBeGreaterThan(initial.sidebar);
  await page.evaluate(() => window.runtimeHarness.message());
  await expect(page.locator("#thread")).toHaveText("first,second");
  expect((await page.evaluate(() => window.runtimeHarness.counts())).workspace).toBe(initial.workspace);
  expect((await page.evaluate(() => window.runtimeHarness.counts())).composer).toBe(initial.composer);
  await page.evaluate(() => window.runtimeHarness.rename());
  await expect(page.locator("#title")).toHaveText("Renamed");
  await expect(page.locator("#composer")).toHaveText("self,peer:false");
  await page.evaluate(() => window.runtimeHarness.unmount());
  expect(errors).toEqual([]);
});
