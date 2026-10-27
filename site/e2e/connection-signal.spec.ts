import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "msedge" });

test("connection indicator displays numeric ping and preserves reconnection states", async ({ page }) => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ConnectionSignal } from './src/components/chat/ConnectionSignal';
    import { VoiceDock } from './src/components/chat/VoiceDock';
    const root = createRoot(document.getElementById('root'));
    window.renderPing = (props, dock = false) => root.render(dock
      ? <VoiceDock title="Канал" muted={false} deafened={false} onToggleMute={() => {}}
          onToggleDeafen={() => {}} onLeave={() => {}} connectionQuality={props.quality} rttMs={props.rttMs} />
      : <ConnectionSignal {...props} />);
  ` }, bundle: true, write: false, platform: "browser", jsx: "automatic" });
  await page.route("**/ping-harness", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("/ping-harness");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const render = (props: { quality?: string; rttMs?: number | null; pending?: string }, dock = false) =>
    page.evaluate(([props, dock]) => (window as unknown as { renderPing(props: unknown, dock: boolean): void }).renderPing(props, dock), [props, dock] as const);
  const signal = page.locator(".connection-signal");
  await render({ quality: "good", rttMs: 42.4 });
  await expect(signal).toHaveText("Пинг: 42 мс");
  await expect(signal).toHaveAccessibleName("Пинг: 42 мс");
  await render({ quality: "poor", rttMs: 512 });
  await expect(signal).toHaveText("Пинг: 512 мс");
  await expect(signal).toHaveClass(/connection-signal--poor/);
  await render({ quality: "good", rttMs: null });
  await expect(signal).toHaveText("Пинг: —");
  await render({ quality: "good", rttMs: 0 });
  await expect(signal).toHaveText("Пинг: 0 мс");
  await render({ quality: "good", rttMs: 42, pending: "Восстановление связи…" });
  await expect(signal).toHaveText("Восстановление связи…");
  await render({ quality: "lost", rttMs: 42 });
  await expect(signal).toHaveText("Связь потеряна");
  await render({ quality: "excellent", rttMs: 63 }, true);
  await expect(signal).toHaveText("Пинг: 63 мс");
});
