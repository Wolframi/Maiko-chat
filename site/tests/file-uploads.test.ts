import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isImageAttachment, MAX_FILE_BYTES, uploadPartFileName, validateAvatarFile, validateFile } from "../src/lib/files";

test("attachments accept arbitrary formats and empty files within the size limit", () => {
  for (const name of ["Отчёт.docx", "таблица.xlsx", "slides.pptx", "archive.7z", "image.svg", "page.html", "data.xml", "app.js", "script.ps1", "program.exe", "model.blend", "photo.tiff", "README", ".env", "unknown.custom-format"]) {
    assert.equal(validateFile(new File(["data"], name)), null, name);
  }
  assert.equal(validateFile(new File([], "empty.txt")), null);
  assert.ok(validateFile({ size: MAX_FILE_BYTES + 1 } as File));
  assert.equal(uploadPartFileName(new File(["data"], "Отчёт.docx")), "upload.docx");
  assert.equal(uploadPartFileName(new File(["data"], "archive.7z")), "upload.7z");
  assert.equal(isImageAttachment({ name: "scan.tiff", mime: "image/tiff" }), false);
  assert.equal(isImageAttachment({ name: "art.psd", mime: "image/vnd.adobe.photoshop" }), false);
  assert.equal(isImageAttachment({ name: "photo.avif", mime: "" }), true);
  assert.ok(validateAvatarFile(new File(["<svg/>"], "avatar.svg", { type: "image/svg+xml" })));
});

test("real multipart uploads preserve arbitrary bytes and extensions and serve downloads safely", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "maiko-file-formats-"));
  const require = createRequire(import.meta.url);
  const uploadsModule = fileURLToPath(new URL("../src/server/uploads.ts", import.meta.url));
  try {
    execFileSync(process.execPath, ["--require", require.resolve("tsx/cjs"), "-e", `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const http = require('node:http');
      fs.mkdirSync('data', {recursive:true});
      fs.writeFileSync('data/users.json', JSON.stringify([{id:'upload-user',username:'uploaduser',displayName:'Upload User',passwordHash:'unused',createdAt:Date.now()}]));
      fs.writeFileSync('data/sessions.json', JSON.stringify([{token:'upload-token',userId:'upload-user',issuedAt:Date.now()}]));
      const {handleUpload,tryServeUpload,uploadOwnedBy} = require(${JSON.stringify(uploadsModule)});
      const server = http.createServer((req,res) => {
        if(req.url.startsWith('/api/upload')) handleUpload(req,res);
        else if(!tryServeUpload(req,res)) {res.statusCode=404;res.end();}
      });
      (async()=>{
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const base='http://127.0.0.1:'+server.address().port;
        try {
          const cases=[
            ['Отчёт.docx','application/octet-stream'], ['таблица.xlsx',''], ['slides.pptx',''],
            ['archive.zip','application/zip'], ['archive.7z',''], ['archive.tar.gz',''],
            ['image.svg','image/svg+xml'], ['page.html','text/html'], ['data.xml','application/xml'],
            ['app.js','text/javascript'], ['module.wasm','application/wasm'], ['script.ps1',''],
            ['program.exe','application/octet-stream'], ['photo.tiff','image/tiff'],
            ['model.blend',''], ['database.sqlite',''], ['README',''], ['unknown.xyz123',''],
            ['original.custom','image/png'], ['empty.txt','text/plain']
          ];
          for(const [name,type] of cases) {
            const bytes=name==='empty.txt'?Buffer.alloc(0):Buffer.from('original bytes: '+name+'\\0\\xff');
            const form=new FormData();form.append('originalName',name);form.append('file',new Blob([bytes],{type}),'upload.bin');
            const response=await fetch(base+'/api/upload',{method:'POST',headers:{origin:base,'x-pulse-token':'upload-token'},body:form});
            const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true,name);
            assert.equal(result.file.name,name.replace(/[^\\p{L}\\p{N}._-]+/gu,'_'),name);
            const ext=require('node:path').extname(name);if(ext)assert.equal(require('node:path').extname(result.file.url.split('?')[0]),ext);
            assert.equal(result.file.size,bytes.length);
            assert.equal(uploadOwnedBy(result.file.url,'upload-user'),true);
            assert.equal(uploadOwnedBy(result.file.url,'another-user'),false);
            const download=await fetch(base+result.file.url+'&download=1&name='+encodeURIComponent(name));
            assert.equal(download.status,200,name);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
            assert.match(download.headers.get('content-disposition'),/^attachment;/);
            assert.equal(download.headers.get('content-type'),'application/octet-stream');
            assert.equal(download.headers.get('x-content-type-options'),'nosniff');
            assert.match(download.headers.get('content-security-policy'),/sandbox/);
            assert.equal(decodeURIComponent(download.headers.get('content-disposition').split("filename*=UTF-8''")[1]),name);
            const plain=await fetch(base+result.file.url);assert.match(plain.headers.get('content-disposition'),/^attachment;/);await plain.arrayBuffer();
            assert.equal((await fetch(base+result.file.url.split('?')[0])).status,403);
          }
          const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
          const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'photo.png');
          const result=await(await fetch(base+'/api/upload',{method:'POST',headers:{origin:base,'x-pulse-token':'upload-token'},body:form})).json();
          assert.equal(result.ok,true);const image=await fetch(base+result.file.url);assert.equal(image.headers.get('content-type'),'image/png');assert.match(image.headers.get('content-disposition'),/^inline;/);await image.arrayBuffer();
          const avatar=new FormData();avatar.append('file',new Blob(['<svg/>'],{type:'image/svg+xml'}),'avatar.svg');
          assert.equal((await fetch(base+'/api/upload?kind=avatar',{method:'POST',headers:{origin:base,'x-pulse-token':'upload-token'},body:avatar})).status,400);
        } finally {await new Promise(resolve=>server.close(resolve));}
      })().catch(error=>{console.error(error);process.exitCode=1});
    `], { cwd: folder, env: { ...process.env, MEDIA_STORAGE: "local", UPLOAD_SIGNING_SECRET: "formats-test-secret" }, encoding: "utf8", windowsHide: true, timeout: 45_000 });
  } finally {
    assert.equal(path.dirname(folder), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith("maiko-file-formats-"));
    rmSync(folder, { recursive: true, force: true });
  }
});
