const { _electron: electron } = require('playwright');
const { build } = require('esbuild');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

async function fixtureServer() {
  const root = path.resolve(__dirname, '../../site');
  const result = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ChatSidebar } from './src/components/chat/ChatSidebar';
    import { GuildMemberList } from './src/components/chat/GuildMemberList';
    const noop = () => {};
    const initial = Array.from({ length: 32 }, (_, i) => ({ id: 'user-'+i,
      username: 'member'+i, displayName: 'Участник '+String(i).padStart(2,'0'), online:i<16 }));
    function App() {
      const [legacy, setLegacy] = useState(true);
      const [group, setGroup] = useState('group-a');
      const [calling, setCalling] = useState(false);
      const [people, setPeople] = useState(initial);
      const selected = window.memberFixture?.selected ?? [];
      window.memberFixture = { selected, setLegacy, setGroup, setCalling,
        rename: () => setPeople(p => p.map(u => u.id==='user-1' ? {...u, displayName:'Новое имя', online:false} : u)) };
      const members = group === 'group-a' ? people : people.slice(30);
      const guild = { id:group, type:'group', title:group, members:members.length, online:members.filter(u=>u.online).length,
        memberIds:members.map(u=>u.id), createdBy:members[0].id, unreadCount:0, visibility:'private', textChannels:[], voiceChannels:[] };
      const select = id => selected.push(id === 'user-0' ? 'profile' : id);
      const memberList = <GuildMemberList members={members} ownerId={guild.createdBy} currentUserId="user-0" onSelectMember={select}/>;
      return <div className="app-shell"><div className={'workspace '+(!calling?'has-members':'')}>
        <aside className="workspace__sidebar is-open"><div className="workspace__sidebar-pane">
          <ChatSidebar chats={[guild]} people={people} currentUserId="user-0" currentChatId={group} focus={group}
            onFocusChange={noop} onOpenChat={noop} onOpenDm={select} onCreateGroup={async()=>({ok:true})}
            onInviteToGroup={noop} showCallMembers={calling} compactMembers={!legacy && !calling ? memberList : undefined}/>
          <footer style={{padding:12}}>Профиль внизу панели</footer>
        </div></aside>
        <section className="room"><header className="room__header">Тест адаптивных участников</header><div className="room__stage"><div className="room__stream">Чат</div><form className="composer"><div className="composer__box"><textarea className="composer__input" placeholder="Сообщение"/></div></form></div></section>
        {!calling && memberList}
      </div></div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' });
  const globals = await fs.readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const sheets = await Promise.all([...globals.matchAll(/@import "(\.\/styles\/[^"]+)"/g)]
    .map((match) => fs.readFile(path.join(root, 'src/app', match[1]), 'utf8')));
  const css = '*{box-sizing:border-box}body,p{margin:0}:root{--font-body:"Segoe UI",sans-serif}button,input,textarea{font:inherit}' + sheets.join('\n');
  const html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Адаптивные участники</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : req.url === '/style.css' ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/fixture.js' ? result.outputFiles[0].text : req.url === '/style.css' ? css : html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function main() {
  const server = await fixtureServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes('--serve')) { console.log(`Members fixture: ${origin}`); return; }
  const output = path.resolve(__dirname, '../test-output');
  const env = { ...process.env, MAIKO_DESKTOP_TEST: '1', MAIKO_DESKTOP_URL: origin,
    MAIKO_DESKTOP_USER_DATA: path.join(output, `compact-members-${Date.now()}`) };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.MAIKO_TEST_EXECUTABLE || require('electron'),
      args: process.env.MAIKO_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env, timeout: 120_000 });
    app.context().setDefaultTimeout(15_000);
    const shell = await app.firstWindow();
    await shell.waitForFunction(async () => (await window.maikoDesktop?.state())?.phase === 'ready', null, { timeout: 60_000 });
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      page = app.windows().find((page) => page.url().startsWith(origin));
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(page, 'React member fixture loaded');
    await page.waitForFunction(() => !!window.memberFixture);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const compact = page.locator('.sidebar__responsive-members');
    for (const legacy of [true, false]) {
      await page.evaluate((value) => window.memberFixture.setLegacy(value), legacy);
      for (const width of [1200, 1101, 1100, 1000, 800, 1200]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setBounds({ width: width + 12, height: 650 }), width);
        await page.waitForFunction((width) => innerWidth === width, width);
        if (width > 1100) {
          await page.waitForFunction(() => !document.querySelector('.sidebar__responsive-members') || getComputedStyle(document.querySelector('.sidebar__responsive-members')).display === 'none');
          assert.ok(await page.locator('.workspace > .member-rail').isVisible(), 'Wide window uses the right rail');
        } else {
          await compact.waitFor({ state: 'visible' });
          assert.ok(!await page.locator('.workspace > .member-rail').isVisible(), 'Narrow window hides the right rail');
          assert.equal(await compact.locator('.member-rail__row').count(), 32, 'Every participant moves into the sidebar');
          assert.ok(await compact.getByText('Владелец —', { exact: false }).isVisible(), 'Owner grouping remains');
          const ordered = await page.evaluate(() => !!(document.querySelector('[data-guild-anchor="invite"]').compareDocumentPosition(document.querySelector('.sidebar__responsive-members')) & Node.DOCUMENT_POSITION_FOLLOWING));
          assert.ok(ordered, 'Participants follow Invite');
          const last = compact.locator('.member-rail__row').last();
          await last.scrollIntoViewIfNeeded();
          const bounds = await last.boundingBox();
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= await page.evaluate(() => innerHeight), 'Last member is reachable by scrolling');
          await compact.locator('.member-rail__row').first().click();
          assert.equal(await page.evaluate(() => window.memberFixture.selected.at(-1)), 'profile', 'Selecting self opens the profile');
          await compact.locator('button[title="@member1"]').click();
          assert.equal(await page.evaluate(() => window.memberFixture.selected.at(-1)), 'user-1', 'Selecting a participant opens their chat');
          if (width === 1000) await page.screenshot({ path: path.join(output, `compact-members-${legacy ? 'desktop-adapter' : 'react'}.png`) });
        }
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1012 }));
      await compact.waitFor({ state: 'visible' });
      await page.evaluate(() => window.memberFixture.rename());
      await compact.getByText('Новое имя', { exact: true }).waitFor();
      await page.evaluate(() => window.memberFixture.setGroup('group-b'));
      await page.waitForFunction(() => document.querySelector('.sidebar__responsive-members')?.querySelectorAll('.member-rail__row').length === 2);
      assert.equal(await compact.locator('.member-rail__row').count(), 2, 'Switching groups replaces the participants');
      await page.evaluate(() => window.memberFixture.setGroup('group-a'));
      await page.waitForFunction(() => document.querySelector('.sidebar__responsive-members')?.querySelectorAll('.member-rail__row').length === 32);
      if (!legacy) assert.equal(await page.locator('[data-maiko-compact-members]').count(), 0, 'Updated frontend does not get a duplicate desktop list');
    }
    await page.evaluate(() => window.memberFixture.setCalling(true));
    await page.locator('.sidebar__call-members').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.sidebar__responsive-members'));
    const callMembers = page.locator('.sidebar__call-members');
    assert.equal(await callMembers.locator('.member-rail__row').count(), 32, 'Group calls show every participant');
    for (const heading of ['Владелец —', 'В сети —', 'Не в сети —']) {
      assert.ok(await callMembers.getByText(heading, { exact: false }).isVisible(), 'Call members keep owner and presence groups');
    }
    assert.equal(await page.getByRole('separator', { name: 'Изменить высоту каналов и участников' }).count(), 0, 'Call members need no height divider');
    const ordered = await page.evaluate(() => !!(document.querySelector('[data-guild-anchor="invite"]').compareDocumentPosition(document.querySelector('.sidebar__call-members')) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.ok(ordered, 'Call members follow Invite');
    const lastCallMember = callMembers.locator('.member-rail__row').last();
    await lastCallMember.scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.sidebar__list--guild').evaluate(el => el.scrollTop > 0), 'Channels and call members share one scroller');
    const lastBounds = await lastCallMember.boundingBox();
    assert.ok(lastBounds.y >= 0 && lastBounds.y + lastBounds.height <= await page.evaluate(() => innerHeight), 'Last call member is reachable');
    await callMembers.locator('.member-rail__row').first().click();
    assert.equal(await page.evaluate(() => window.memberFixture.selected.at(-1)), 'profile', 'Selecting self during a call opens the profile');
    await callMembers.locator('button[title="@member2"]').click();
    assert.equal(await page.evaluate(() => window.memberFixture.selected.at(-1)), 'user-2', 'Selecting a call member opens their chat');
    console.log('Compact members passed: 1100px boundary, wide/narrow return, legacy and updated React frontend, all members, owner/status groups, scrolling, self/profile and member/chat clicks, live updates, group changes, no duplicate and group calls.');
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
