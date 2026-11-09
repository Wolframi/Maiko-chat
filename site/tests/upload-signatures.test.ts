import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("every media type, thumbnail, waveform, range and HEAD requires a valid unexpired upload signature", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-upload-security-"));
  const loader = createRequire(import.meta.url).resolve("tsx/cjs");
  const sharpModule = createRequire(import.meta.url).resolve("sharp");
  const uploadsModule = fileURLToPath(new URL("../src/server/uploads.ts", import.meta.url));
  const video = fileURLToPath(new URL("../e2e/fixtures/media-loading.webm", import.meta.url));
  try {
    execFileSync(process.execPath, ["--require", loader, "-e", `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const http = require('node:http');
      const {tryServeUpload,signUploadUrl} = require(${JSON.stringify(uploadsModule)});
      fs.mkdirSync('uploads',{recursive:true});
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
      const server=http.createServer((req,res)=>{if(!tryServeUpload(req,res)){res.statusCode=404;res.end();}});
      (async()=>{
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const base='http://127.0.0.1:'+server.address().port;
        try {
          for(const extension of ['png','gif','webp','mp4','webm','mp3','txt']) {
            const name='00000000-0000-4000-8000-000000000000.'+extension;
            fs.writeFileSync('uploads/'+name,extension==='png'?png:Buffer.from('test bytes'));
            const bare='/uploads/'+name;
            const signed=signUploadUrl(bare);
            const invalid=[bare,bare+'?exp='+ (Date.now()+60000)+'&sig='+'0'.repeat(64),signUploadUrl(bare,-1000)];
            for(const url of invalid) for(const method of ['GET','HEAD']) {
              const response=await fetch(base+url,{method}); assert.equal(response.status,403,url); await response.arrayBuffer();
            }
            for(const query of ['?w=320','?w=430&poster=1','?waveform=1','?download=1','?microPreview=1']) {
              const response=await fetch(base+bare+query,{headers:{Range:'bytes=0-2'}});assert.equal(response.status,403);await response.arrayBuffer();
            }
            let response=await fetch(base+signed,{method:'HEAD'});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
            response=await fetch(base+signed,{headers:{Range:'bytes=0-2'}});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,3);
          }
          const sharp = require(${JSON.stringify(sharpModule)});
          const photo = '/uploads/00000000-0000-4000-8000-222222222222.png';
          await sharp({create:{width:1200,height:800,channels:4,background:'#ff000080'}})
            .png({compressionLevel:0}).toFile('.'+photo);
          const photoUrl = base + signUploadUrl(photo) + '&w=430';
          for (const method of ['GET','HEAD']) {
            const response = await fetch(photoUrl, {method});
            assert.equal(response.status,200);
            assert.equal(response.headers.get('content-type'),'image/webp');
            assert.match(response.headers.get('cache-control'),/no-store/);
            assert.ok(Number(response.headers.get('content-length'))>0);
            const body = Buffer.from(await response.arrayBuffer());
            if(method==='HEAD') assert.equal(body.length,0);
            else {
              const metadata = await sharp(body).metadata();
              assert.equal(metadata.width,430);
              assert.equal(metadata.hasAlpha,true);
            }
          }
          assert.equal((await fetch(base+photo+'?w=430')).status,403);
          assert.equal((await fetch(base+signUploadUrl(photo,-1000)+'&w=430')).status,403);
          const metadataUrl=base+signUploadUrl(photo)+'&microPreview=1';
          const metadata=await fetch(metadataUrl);
          assert.equal(metadata.status,200);assert.ok(metadata.headers.get('content-type').includes('application/json'));
          assert.match(metadata.headers.get('cache-control'),/no-store/);
          const hash=await metadata.json();assert.equal(typeof hash.microPreview,'string');const micro = await sharp(Buffer.from(hash.microPreview.split(',')[1],'base64')).metadata();assert.equal(micro.format,'jpeg');assert.equal(micro.width,32);assert.equal(micro.height,21);
          const metadataHead=await fetch(metadataUrl,{method:'HEAD'});assert.equal(metadataHead.status,200);
          assert.equal((await metadataHead.arrayBuffer()).byteLength,0);
          const gifMetadata=await fetch(base+signUploadUrl('/uploads/00000000-0000-4000-8000-000000000000.gif')+'&microPreview=1');
          assert.equal(gifMetadata.status,204);
          const clip='/uploads/00000000-0000-4000-8000-111111111111.webm';
          fs.copyFileSync(${JSON.stringify(video)},'.'+clip);
          const cover=await fetch(base+signUploadUrl(clip)+'&w=430&poster=1');
          assert.equal(cover.status,200); assert.equal(cover.headers.get('content-type'),'image/webp');
          const frame=Buffer.from(await cover.arrayBuffer()); assert.equal(frame.toString('ascii',8,12),'WEBP');
          const expired=await fetch(base+signUploadUrl(clip,-1000)+'&w=430&poster=1');assert.equal(expired.status,403);
          const response=await fetch(base+'/uploads/00000000-0000-4000-8000-999999999999.png');assert.equal(response.status,403);
        } finally { await new Promise(resolve=>server.close(resolve)); }
      })().catch(error=>{console.error(error);process.exitCode=1});
    `], { cwd: folder, env: { ...process.env, MEDIA_STORAGE: "local", UPLOAD_SIGNING_SECRET: "security-test-secret" }, encoding: "utf8", windowsHide: true, timeout: 45_000 });
  } finally {
    assert.equal(path.dirname(folder), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith("maiko-upload-security-"));
    rmSync(folder, { recursive: true, force: true });
  }
});
