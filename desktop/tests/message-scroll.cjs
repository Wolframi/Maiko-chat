const { _electron: electron } = require('playwright');
const { build } = require('esbuild');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

async function main() {
  const root = path.resolve(__dirname, '../../site');
  const script = (await build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {MessageList} from './src/components/chat/MessageList';
      window.wheelCount=0;
      document.addEventListener('wheel',()=>window.wheelCount++,true);
      const account={userId:'self',username:'self',displayName:'Self'},people=[],typing=[];
      const rows=(from,to)=>Array.from({length:to-from},(_,offset)=>{
        const i=from+offset;
        const peer=${process.env.MAIKO_SCROLL_OWN !== '1'}&&(${process.env.MAIKO_SCROLL_CLUSTERED === '1'}||i%5);
        const message={id:'row-'+i,room:'test',authorId:peer?'peer':'self',author:peer?'Peer':'Self',
          kind:'text',createdAt:1700000000000+i*30000,text:i+': '+'Variable height history. '.repeat(i%12+1)};
        if(${process.env.MAIKO_SCROLL_MEDIA === '1'} && i%9===0) return {...message,kind:'file',file:{
          url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          name:'photo.png',mime:'image/png',size:70,width:1600,height:900}};
        return message;
      });
      function App(){
        const [messages,setMessages]=useState(rows(240,320));
        const [loading,setLoading]=useState(false);
        const [target,setTarget]=useState(null);
        window.setSearchTarget=setTarget;
        const first=Number(messages[0].id.slice(4));
        return <div className="app-shell"><div className="workspace" style={{display:'flex'}}>
          <section className="room" style={{width:'100%'}}><div className="room__stage"><div className="room__stream">
          <MessageList chatId="test" messages={messages} people={people} account={account} othersTyping={typing}
            showOwnAvatar
            activeMatchId={target} searchQuery={target?'History':''}
            hasMore={first>0} loadingOlder={loading} onLoadOlder={async()=>{
              setLoading(true); await new Promise(resolve=>setTimeout(resolve,120));
              setMessages(current=>[...rows(Math.max(0,first-80),first),...current]);setLoading(false);return true;
            }}/>
          </div></div></section></div></div>;
      }
      window.scrollSamples=[];
      const sample=()=>{
        const scroller=document.querySelector('.room__messages');
        if(scroller){
          const bounds=scroller.getBoundingClientRect();
          const row=[...scroller.querySelectorAll('[id^="msg-row-"]')].find(row=>row.getBoundingClientRect().bottom>bounds.top);
          if(row){const rect=row.getBoundingClientRect();window.scrollSamples.push({
            position:Number(row.id.slice(8))+(bounds.top-rect.top)/rect.height,
            scroll:scroller.scrollTop,loaded:document.querySelector('.room__messages-wrap').dataset.loadedMessages,
            wheel:window.wheelCount,height:scroller.scrollHeight,
            avatarError:Math.max(0,...[...scroller.querySelectorAll('.message-avatar-group[data-avatar-overlay]')].map(group=>{
              const box=group.getBoundingClientRect();
              if(box.top>=bounds.top||box.bottom<=bounds.bottom)return 0;
              return Math.abs(group.querySelector('.avatar').getBoundingClientRect().bottom-(bounds.bottom-8));
            })),
            singleAvatarError:Math.max(0,...[...scroller.querySelectorAll('[data-avatar-single] .bubble-row > .avatar')].map(avatar=>{
              const box=avatar.parentElement.getBoundingClientRect();
              return box.bottom<=bounds.top||box.top>=bounds.bottom?0:Math.abs(avatar.getBoundingClientRect().bottom-box.bottom);
            })),
          });}
        }
        requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
      createRoot(document.getElementById('root')).render(<App/>);
    `}, bundle: true, write: false, jsx: 'automatic', minify: false,
    define: {'process.env.NODE_ENV':'"production"'},
  })).outputFiles[0].text;
  const globals = await fs.readFile(path.join(root,'src/app/globals.css'),'utf8');
  const styles = (await Promise.all([...globals.matchAll(/@import "(\.\/styles\/[^"]+)"/g)]
    .map(match=>fs.readFile(path.join(root,'src/app',match[1]),'utf8')))).join('\n');
  const server=http.createServer((request,response)=>{
    if(request.url==='/api/health'){response.setHeader('content-type','application/json');response.end('{"desktopMediaHost":1}');return;}
    response.setHeader('content-type','text/html; charset=utf-8');
    if(request.url==='/desktop-runtime') response.end('<!doctype html><title>Scroll host</title><script>window.maikoMediaRuntime={version:1}</script><iframe data-maiko-desktop-ui src="/chat" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>');
    else response.end('<!doctype html><style>*,*::before,*::after{box-sizing:border-box}body,p{margin:0}'+styles+'</style><div id="root"></div><script>'+script+'</script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const output=path.resolve(__dirname,'../test-output/message-scroll-'+Date.now());
  await fs.mkdir(output,{recursive:true});
  const env={...process.env,MAIKO_DESKTOP_TEST:'1',MAIKO_DESKTOP_USER_DATA:path.join(output,'profile'),MAIKO_DESKTOP_URL:origin};
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try{
    app=await electron.launch({executablePath:process.env.MAIKO_TEST_EXECUTABLE||require('electron'),
      args:process.env.MAIKO_TEST_EXECUTABLE?[]:[path.resolve(__dirname,'..')],env,timeout:120000});
    app.context().setDefaultTimeout(20000);
    await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setBounds({width:1000,height:800});win.show();win.focus();});
    const shell=await app.firstWindow();
    await shell.waitForFunction(async()=> (await window.maikoDesktop?.state())?.phase==='ready',null,{timeout:60000});
    let host;
    for(let attempt=0;attempt<60&&!host;attempt++){
      host=app.windows().find(page=>page.url().startsWith(origin));
      if(!host) await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(host,JSON.stringify(app.windows().map(page=>page.url())));
    const frame=await (await host.locator('iframe').elementHandle()).contentFrame();
    await frame.locator('#msg-row-319').waitFor();
    await frame.waitForFunction(()=>{const s=document.querySelector('.room__messages');return s.scrollHeight-s.scrollTop-s.clientHeight<2;});
    const scroller=frame.locator('.room__messages');
    const errors=[];host.on('pageerror',error=>errors.push(error.message));
    const bounds=await scroller.boundingBox();
    await host.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
    for(const direction of [-1,1]){
      await frame.evaluate(()=>{window.scrollSamples=[];});
      for(let i=0;i<400;i++){
        await host.mouse.wheel(0, direction*150);
        await new Promise(resolve=>setTimeout(resolve,35));
        if(i%20===19){
          const finished=await scroller.evaluate((s,direction)=>direction<0
            ? s.scrollTop<2 && document.querySelector('.room__messages-wrap').dataset.loadedMessages==='320'
            : s.scrollHeight-s.scrollTop-s.clientHeight<2,direction);
          if(finished)break;
        }
      }
      await new Promise(resolve=>setTimeout(resolve,600));
      const samples=await frame.evaluate(()=>window.scrollSamples);
      const backwards=samples.slice(1).map((sample,index)=>({amount:(samples[index].position-sample.position)*direction,before:samples[index],after:sample})).filter(item=>item.amount>0.15);
      await fs.writeFile(path.join(output,direction<0?'up.json':'down.json'),JSON.stringify({samples,backwards,errors},null,2));
      console.log(JSON.stringify({direction,samples:samples.length,first:samples[0],last:samples.at(-1),backwards:backwards.slice(0,6),errors}));
      assert.equal(backwards.length,0,'Native wheel scrolling must not jump in the opposite direction');
      assert.ok(Math.max(...samples.map(sample=>sample.avatarError))<0.5,'Streak avatars remain pinned on every painted frame');
      assert.ok(Math.max(...samples.map(sample=>sample.singleAvatarError))<0.5,'Single-row avatars move only with their row');
      assert.equal(await frame.locator('.room__messages-wrap').getAttribute('data-loaded-messages'),'320','All three older pages loaded');
    }
    await frame.evaluate(()=>window.setSearchTarget('row-160'));
    await frame.locator('#msg-row-160').waitFor({state:'visible'});
    await frame.waitForFunction(()=>{const r=document.getElementById('msg-row-160').getBoundingClientRect();return r.top>0&&r.bottom<innerHeight;});
    const before=await scroller.evaluate(s=>s.scrollTop);
    await host.mouse.wheel(0,-300);
    await frame.waitForFunction(before=>document.querySelector('.room__messages').scrollTop<before-200,before);
    await new Promise(resolve=>setTimeout(resolve,600));
    assert.ok(await scroller.evaluate(s=>s.scrollTop)<before-200,'Search navigation releases manual scrolling');
    await frame.evaluate(()=>window.setSearchTarget(null));
    await frame.getByRole('button',{name:'Прокрутить вниз',exact:true}).click();
    await frame.waitForFunction(()=>{const s=document.querySelector('.room__messages');return s.scrollHeight-s.scrollTop-s.clientHeight<2;});
    console.log('Search, subsequent wheel input and jump to latest passed.');
    assert.deepEqual(errors,[]);
  } finally{await app?.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
