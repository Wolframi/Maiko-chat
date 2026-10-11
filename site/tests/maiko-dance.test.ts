import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chooseMaikoIntro, chooseMaikoDanceStart, decodeMaikoDance, maikoDanceFrame, maikoIntroDuration, MAIKO_DANCE_SECONDS, MAIKO_GROUND_Y, skinMaikoPoint } from "../src/lib/maikoDance";

for(const intro of ["hiphop","samba"] as const) {
  const bytes=readFileSync(new URL(`../public/models/maiko-${intro}.bin`,import.meta.url));
  const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  test(`${intro}: supplied FBX skeleton moves the detailed surface without losing facial contrast`,()=>{
    const dance=decodeMaikoDance(buffer);
    assert.equal(dance.count,84000);assert.equal(dance.bones,65);
    assert.ok(buffer.byteLength<2600000);
    const first=maikoDanceFrame(dance,0),later=maikoDanceFrame(dance,2.1);
    let moved=0,dark=0,light=0;
    const p=new Float32Array(6),q=new Float32Array(6);
    const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<dance.count;i+=10) {
      skinMaikoPoint(dance,i,first,p);skinMaikoPoint(dance,i,later,q);
      assert.ok(p.every(Number.isFinite)&&q.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(p[3],p[4],p[5])-1)<0.001);
      if(Math.hypot(p[0]-q[0],p[1]-q[1],p[2]-q[2])>0.05) moved++;
      if(dance.data[i*16+14]<0.1) dark++;
      if(dance.data[i*16+14]>0.6) light++;
      for(let j=0;j<3;j++) {low[j]=Math.min(low[j],p[j]);high[j]=Math.max(high[j],p[j]);}
    }
    assert.ok(moved>1000,`Only ${moved} animated samples`);
    assert.ok(dark>10&&light>10,`Lost texture contrast ${dark}/${light}`);
    assert.ok(high[1]-low[1]>2.2&&high[1]-low[1]<2.6,`Character must be upright, height ${high[1]-low[1]}`);
    assert.equal(decodeMaikoDance(buffer,40000).count,40000);
    assert.ok(dance.duration>15,"Full animation is needed for varied six-second segments");
    assert.ok(maikoIntroDuration[intro]/1000>MAIKO_DANCE_SECONDS);
  });
  test(`${intro}: frame interpolation stays inside the palette and reduced motion is still`,()=>{
    const dance=decodeMaikoDance(buffer,1);
    for(const time of [0,0.01,1,2,4,7,12,100]) {
      const frame=maikoDanceFrame(dance,time);
      assert.ok(frame[0]>=0&&frame[1]<dance.frames&&frame[2]>=0&&frame[2]<=1);
      assert.deepEqual(maikoDanceFrame(dance,time,false),[0,1,0]);
    }
  });
  test(`${intro}: soles stay on the platform throughout the clip`,()=>{
    // Use the rendered desktop surface: decimation can omit the lowest sole samples.
    const dance=decodeMaikoDance(buffer),point=new Float32Array(6);
    for(let f=0;f<dance.frames;f+=4) {
      let floor=Infinity;
      for(let i=0;i<dance.count;i++) floor=Math.min(floor,skinMaikoPoint(dance,i,[f,f,0],point)[1]);
      assert.ok(Math.abs(floor-MAIKO_GROUND_Y)<0.012,`Frame ${f}: sole ${floor}, platform ${MAIKO_GROUND_Y}`);
    }
  });
  test(`${intro}: different starting moments retain six continuous seconds without wrapping`,()=>{
    const dance=decodeMaikoDance(buffer,1),starts=[0,0.25,0.5,0.999].map(random=>chooseMaikoDanceStart(dance.duration,random));
    assert.equal(new Set(starts).size,4);
    for(const start of starts) {
      const first=maikoDanceFrame(dance,0,true,start),last=maikoDanceFrame(dance,7.1,true,start);
      assert.ok(Math.abs((first[0]+first[2])/dance.fps-start)<0.0001);
      assert.ok(Math.abs((last[0]+last[2])/dance.fps-start-MAIKO_DANCE_SECONDS)<0.0001);
      assert.ok(last[1]<dance.frames);
      assert.deepEqual(maikoDanceFrame(dance,5,false,start),[0,1,0]);
    }
  });
  test(`${intro}: corrupt/truncated skin data is rejected`,()=>{
    assert.throws(()=>decodeMaikoDance(buffer.slice(0,-1)));
    const corrupt=buffer.slice(0);new DataView(corrupt).setUint8(44,255);
    assert.throws(()=>decodeMaikoDance(corrupt));
    const weights=buffer.slice(0);new DataView(weights).setUint8(48,0);
    assert.throws(()=>decodeMaikoDance(weights));
  });
}
test("the intro randomly chooses between the two dances",()=>{
  assert.equal(chooseMaikoIntro(0),"hiphop");assert.equal(chooseMaikoIntro(0.4999),"hiphop");
  assert.equal(chooseMaikoIntro(0.5),"samba");assert.equal(chooseMaikoIntro(0.9999),"samba");
});
