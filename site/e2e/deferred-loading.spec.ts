import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

test.use({ channel: "msedge" });

test("closed features do not load; first open, close/reopen and failed-download retry preserve the chat", async ({ page }) => {
  const bundle = (await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {FeatureGate, deferredFeature} from './src/components/chat/DeferredFeature';
    let loads=0;
    function Panel({open}) {const [value,setValue]=useState('draft');return open?<input aria-label="Panel draft" value={value} onChange={e=>setValue(e.target.value)}/>:null;}
    const Deferred=deferredFeature(async()=>{loads++;if(loads===1)throw new Error('Temporary chunk failure');return Panel;});
    function App(){const[open,setOpen]=useState(false);return <><input aria-label="Chat draft"/><button onClick={()=>setOpen(v=>!v)}>Toggle panel</button>
      <FeatureGate active={open}><Deferred open={open}/></FeatureGate></>;}
    window.featureLoads=()=>loads; createRoot(document.body).render(<App/>);
  ` }, bundle: true, write: false, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  await page.route("**/feature-gate", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("http://127.0.0.1:3000/feature-gate");
  await page.addScriptTag({ content: bundle });
  await page.getByRole("textbox", { name: "Chat draft" }).fill("keep my message");
  expect(await page.evaluate("window.featureLoads()")).toBe(0);
  await page.getByRole("button", { name: "Toggle panel" }).click();
  await expect(page.getByRole("alert")).toContainText("Не удалось открыть панель");
  await expect(page.getByRole("textbox", { name: "Chat draft" })).toHaveValue("keep my message");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await page.getByRole("textbox", { name: "Panel draft" }).fill("keep panel state");
  await page.getByRole("button", { name: "Toggle panel" }).click();
  await expect(page.getByRole("textbox", { name: "Panel draft" })).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle panel" }).click();
  await expect(page.getByRole("textbox", { name: "Panel draft" })).toHaveValue("keep panel state");
  expect(await page.evaluate("window.featureLoads()")).toBe(2);
});

async function sdkHarness(page: Page, mode: "normal" | "stalled" | "fail-once" | "room") {
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {useVoiceChannelLiveKit} from './src/hooks/useVoiceChannelLiveKit';
    import {loadLiveKit} from './src/lib/liveKitLoader';
    const socket={on(){},off(){},emit(){},connected:true}; let api,outcome='idle';
    function App(){api=useVoiceChannelLiveKit({socket,selfId:'self',token:'test',managedPresence:true});return <p>Voice controller ready</p>;}
    window.sdkHarness={start(){outcome='pending';void api.startMedia('channel','group','Voice').then(()=>outcome='connected',e=>outcome=e.name);},
      async startMockRoom(){
        const sdk=await loadLiveKit();
        const on=sdk.Room.prototype.on;
        sdk.Room.prototype.on=function(...args){
          // Room defines transport methods as instance fields. Install the local
          // transport when the real hook wires its first room event listener.
          this.connect=async()=>{this.state='connected';this.localParticipant.setMicrophoneEnabled=async()=>{};};
          this.startAudio=async()=>{};
          this.disconnect=async()=>{this.state='disconnected';};
          return on.apply(this,args);
        };
        outcome='pending'; await api.startMedia('channel','group','Voice'); outcome='connected';
      },
      stop(){api.stopMedia();},state(){return{outcome,joining:api.joining,error:api.error,active:api.active};}};
    createRoot(document.body).render(<App/>);
  ` }, bundle: true, write: false, splitting: true, format: "esm", outdir: "tmp/deferred-sdk", metafile: true,
    jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const assets = new Map(result.outputFiles.map(file => ["/" + path.basename(file.path), file.text]));
  const sdkFiles = new Set(Object.entries(result.metafile!.outputs).filter(([, value]) =>
    Object.keys(value.inputs).some(name => name.includes("node_modules/livekit-client/"))).map(([name]) => "/" + path.basename(name)));
  const entry = "/" + path.basename(Object.keys(result.metafile!.outputs).find(name => result.metafile!.outputs[name].entryPoint === "<stdin>")!);
  let requests = 0;
  await page.route("http://127.0.0.1:3000/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><body><script type="module" src="${entry}"></script></body>` });
    if (pathname === "/api/livekit/token") return mode === "room"
      ? route.fulfill({ json: { serverUrl: "ws://127.0.0.1:9", participantToken: "local-test" } })
      : route.fulfill({ status: 503, json: { error: "Test SFU unavailable" } });
    if (sdkFiles.has(pathname)) {
      requests++;
      if (mode === "stalled") return;
      if (mode === "fail-once" && requests === 1) return route.abort("failed");
    }
    const body = assets.get(pathname);
    return body ? route.fulfill({ contentType: "text/javascript", body }) : route.fulfill({ status: 404 });
  });
  await page.goto("http://127.0.0.1:3000/");
  await expect(page.getByText("Voice controller ready")).toBeVisible();
  return () => requests;
}

test("idle voice controller does not fetch LiveKit; joining loads it once and reports server errors", async ({ page }) => {
  const requests = await sdkHarness(page, "normal");
  expect(requests()).toBe(0);
  await page.evaluate("window.sdkHarness.start()");
  await expect.poll(() => page.evaluate("window.sdkHarness.state().outcome")).toBe("Error");
  expect(requests()).toBeGreaterThan(0);
  const first = requests();
  expect(await page.evaluate("window.sdkHarness.state()")).toMatchObject({ joining: false, error: "Test SFU unavailable", active: null });
  await page.evaluate("window.sdkHarness.start()");
  await expect.poll(() => page.evaluate("window.sdkHarness.state().outcome")).toBe("Error");
  expect(requests()).toBe(first);
});

test("leaving during a stalled SDK download cancels the join promptly", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const requests = await sdkHarness(page, "stalled");
  await page.evaluate("window.sdkHarness.start()");
  await expect.poll(requests).toBeGreaterThan(0);
  // Let the active voice meter tick while the SDK and room are still unavailable.
  await page.waitForTimeout(350);
  await page.evaluate("window.sdkHarness.stop()");
  await expect.poll(() => page.evaluate("window.sdkHarness.state().outcome")).toBe("AbortError");
  expect(await page.evaluate("window.sdkHarness.state()")).toMatchObject({ joining: false, active: null });
  expect(errors).toEqual([]);
});

test("a failed SDK download can be retried on the next join", async ({ page }) => {
  const requests = await sdkHarness(page, "fail-once");
  await page.evaluate("window.sdkHarness.start()");
  await expect.poll(() => page.evaluate("window.sdkHarness.state().joining")).toBe(false);
  await expect.poll(requests).toBe(1);
  await page.evaluate("window.sdkHarness.start()");
  await expect.poll(() => page.evaluate("window.sdkHarness.state().error")).toBe("Test SFU unavailable");
  expect(requests()).toBe(2);
});

test("the deferred SDK constructs a room, wires controls and leaves cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const requests = await sdkHarness(page, "room");
  expect(requests()).toBe(0);
  await page.evaluate("window.sdkHarness.startMockRoom()");
  expect(await page.evaluate("window.sdkHarness.state()")).toMatchObject({
    outcome: "connected", joining: false, error: null, active: { channelId: "channel" },
  });
  expect(requests()).toBeGreaterThan(0);
  await page.evaluate("window.sdkHarness.stop()");
  expect(await page.evaluate("window.sdkHarness.state()")).toMatchObject({ joining: false, active: null });
  expect(errors).toEqual([]);
});
