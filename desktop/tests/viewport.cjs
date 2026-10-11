const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

async function fixtureServer() {
  const root = path.resolve(__dirname, '../../site');
  const globals = await fs.readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const imports = [...globals.matchAll(/@import "(\.\/styles\/[^"]+)"/g)];
  // Simulate an older online frontend: the EXE must supply its viewport fixes.
  const sheets = await Promise.all(imports.filter((match) => !match[1].endsWith('/viewport.css'))
    .map((match) => fs.readFile(path.join(root, 'src/app', match[1]), 'utf8')));
  const reset = '*{box-sizing:border-box}body,p{margin:0}button,input,textarea{font:inherit}[hidden]{display:none!important}';
  const css = process.argv.includes('--compiled')
    ? await fs.readFile(path.resolve(__dirname, '../test-output/compiled-layout.css'), 'utf8')
    : reset + sheets.join('\n');
  const updatedCSS = css + await fs.readFile(path.join(root, 'src/app/styles/viewport.css'), 'utf8');
  const fixture = await fs.readFile(path.join(__dirname, 'fixtures/layout.html'), 'utf8');
  const auth = '<!doctype html><html lang="ru"><head><title>Вход</title><link rel="stylesheet" href="/layout.css"></head><body><div class="app-shell app-shell--auth"><div class="join-wrap"><div class="join"><div class="join__hero">Майко</div><form style="padding:32px">' +
    '<h1>Регистрация</h1>' + Array.from({ length: 20 }, (_, i) => `<label style="display:block;padding:10px">Поле ${i + 1}<input style="display:block" aria-label="Поле ${i + 1}"></label>`).join('') +
    '<button type="button">Продолжить</button></form></div></div></div></body></html>';
  const server = http.createServer((req, res) => {
    const stylesheet = req.url === '/layout.css' || req.url === '/updated.css';
    res.setHeader('content-type', stylesheet ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/layout.css' ? css : req.url === '/updated.css' ? updatedCSS : req.url === '/auth' ? auth : req.url === '/updated' ? fixture.replace('/layout.css', '/updated.css') : fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function checkChat(page, label) {
  // Native resizing and visualViewport events settle on the next painted frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const metrics = await page.evaluate(() => {
    const rect = (selector) => {
      const { x, y, width, height, bottom, right } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height, bottom, right };
    };
    return { width: innerWidth, height: innerHeight, room: rect('.room'), composer: rect('.composer'),
      input: rect('.composer__input'), send: rect('.composer__send'), messages: rect('.room__messages'),
      messagesScroll: document.querySelector('.room__messages').scrollHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  for (const element of ['room', 'composer', 'input', 'send']) {
    const rect = metrics[element];
    assert.ok(rect.y >= -1 && rect.bottom <= metrics.height + 1 && rect.right <= metrics.width + 1,
      `${label}: ${element} stays inside the viewport: ${JSON.stringify(metrics)}`);
  }
  assert.ok(!metrics.horizontalOverflow, `${label}: no horizontal page overflow`);
  assert.ok(metrics.messages.height >= 20, `${label}: history has usable scroll space`);
  assert.ok(metrics.messagesScroll > metrics.messages.height, `${label}: long history scrolls`);
  const before = await page.locator('.composer').boundingBox();
  await page.locator('.room__messages').evaluate((element) => { element.scrollTop = 0; });
  await page.mouse.move(metrics.messages.x + metrics.messages.width / 2, metrics.messages.y + metrics.messages.height / 2);
  await page.mouse.wheel(0, 350);
  await page.waitForFunction(() => document.querySelector('.room__messages').scrollTop > 0);
  assert.deepEqual(await page.locator('.composer').boundingBox(), before, `${label}: scrolling history does not move input`);
  if ((await page.locator('textarea').inputValue()).split('\n').length > 10) {
    assert.ok(await page.locator('textarea').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop > 0 && element.clientHeight >= 40;
    }), `${label}: all lines of a long draft are reachable by scrolling`);
  }
  await page.getByRole('textbox', { name: 'Сообщение' }).click();
  await page.keyboard.insertText(' Проверка ввода');
  assert.ok((await page.getByRole('textbox', { name: 'Сообщение' }).inputValue()).includes('Проверка ввода'));
  return metrics;
}

async function main() {
  const server = await fixtureServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes('--serve')) { console.log(`UI fixture: ${origin}/updated`); return; }
  const output = path.resolve(__dirname, '../test-output');
  const profile = path.join(output, `viewport-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true });
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_USER_DATA: profile, MAIKO_DESKTOP_URL: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120_000 });
    app.context().setDefaultTimeout(15_000);
    const shell = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await shell.waitForFunction(async () => (await window.maikoDesktop?.state())?.phase === 'ready', null, { polling: 100, timeout: 60_000 });
    let page;
    for (let attempt = 0; attempt < 50 && !page; attempt++) {
      page = app.windows().find((page) => page.url().startsWith(origin));
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(page, 'Site renders in its isolated view');
    for (const [width, height] of [[1280, 820], [1000, 700], [800, 600], [1200, 600], [1600, 900]]) {
      await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), { x: 100, y: 100, width, height });
      await page.waitForFunction(([width, height]) => innerWidth === width - 12 && innerHeight === height - 48, [width, height]);
      for (const mode of ['normal', 'group', 'direct', 'mini']) for (const longDraft of [false, true]) {
        await page.evaluate(([mode, longDraft]) => window.setScenario(mode, longDraft), [mode, longDraft]);
        await checkChat(page, `${width}x${height}/${mode}/${longDraft ? 'long' : 'short'}`);
        if (width === 800 && longDraft) await page.screenshot({ path: path.join(output, `viewport-${mode}-800x600.png`) });
      }
      console.log(`Chat layout passed at ${width}x${height}.`);
    }
    // Previously resized call media must yield space after the window shrinks.
    await page.evaluate(() => { document.querySelector('.room').style.setProperty('--call-dock-height', '650px'); window.setScenario('group', true); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1000, height: 600 }));
    await page.waitForFunction(() => innerHeight === 552);
    await checkChat(page, 'large media dock after shrinking');
    await page.reload();
    await shell.waitForFunction(async () => (await window.maikoDesktop.state()).phase === 'ready');
    await checkChat(page, 'stylesheet is reapplied after reload');
    await page.locator('.workspace__sidebar').evaluate((element) => element.classList.add('is-open'));
    const sidebarScroll = await page.locator('.sidebar__list').evaluate((element) => {
      element.scrollTop = 100; return { scroll: element.scrollTop, client: element.clientHeight, height: element.scrollHeight };
    });
    assert.ok(sidebarScroll.scroll > 0 && sidebarScroll.height > sidebarScroll.client, 'Chat list scrolls independently');
    const footer = await page.locator('.sidebar > footer').boundingBox();
    assert.ok(footer.y + footer.height <= await page.evaluate(() => innerHeight), 'Sidebar profile stays reachable');
    await shell.getByRole('button', { name: 'Настройки подключения' }).click();
    await shell.locator('#connection-form > .description').evaluate((element) => {
      element.textContent = 'Длинное описание соединения и настроек. '.repeat(120);
    });
    const connectButton = shell.getByRole('button', { name: 'Подключиться', exact: true });
    await connectButton.scrollIntoViewIfNeeded();
    assert.ok(await shell.locator('.settings-screen').evaluate((element) => element.scrollTop > 0), 'Tall desktop settings scroll');
    const connectBounds = await connectButton.boundingBox();
    assert.ok(connectBounds.y >= 42 && connectBounds.y + connectBounds.height <= await shell.evaluate(() => innerHeight), 'Settings action stays reachable');
    await shell.getByRole('button', { name: 'Назад', exact: true }).click();
    await page.goto(origin + '/auth');
    await page.getByRole('button', { name: 'Продолжить' }).scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.app-shell').evaluate((element) => element.scrollTop > 0), 'Tall login form scrolls');
    const submit = await page.getByRole('button', { name: 'Продолжить' }).boundingBox();
    assert.ok(submit.y >= 0 && submit.y + submit.height <= await page.evaluate(() => innerHeight), 'Login action stays reachable');
    console.log('Viewport regression passed: five window sizes, regular/group/direct/minimized calls, long drafts, replies/attachments, real wheel scrolling, typing, resized media, reload, sidebar and tall login form.');
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { fixtureServer, checkChat };
