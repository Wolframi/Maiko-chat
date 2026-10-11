import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeMaikoPerformance } from "../src/lib/maikoPerformance";

const bytes = readFileSync(new URL("../public/models/maiko-performance.bin", import.meta.url));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
test("detailed model includes moving rig poses and facial contrast", () => {
  const {data,count} = decodeMaikoPerformance(buffer);
  assert.equal(count,84000);
  let moving = 0, turned = 0, dark = 0, light = 0;
  for (let i=0;i<count;i++) {
    const k=i*20;
    assert.ok(data.subarray(k,k+20).every(Number.isFinite));
    for (const offset of [9,12,15]) assert.ok(Math.abs(Math.hypot(data[k+offset],data[k+offset+1],data[k+offset+2])-1)<0.001);
    if(Math.hypot(data[k]-data[k+3],data[k+1]-data[k+4],data[k+2]-data[k+5])>0.1) moving++;
    if(Math.hypot(data[k+9]-data[k+12],data[k+10]-data[k+13],data[k+11]-data[k+14])>0.3) turned++;
    if(data[k+18]<0.1) dark++;
    if(data[k+18]>0.6) light++;
  }
  assert.ok(moving>3000,`Expected rig deformation, got ${moving} moving points`);
  assert.ok(turned>3000,`Expected lighting to follow the greeting pose, got ${turned} rotated normals`);
  assert.ok(dark>100 && light>100,`Expected facial tonal detail, got ${dark}/${light}`);
  assert.equal(decodeMaikoPerformance(buffer,40000).count,40000);
});
test("the previous model format remains readable",()=>{
  const previous = new ArrayBuffer(37);
  const view = new DataView(previous);
  view.setUint32(0,0x46504b4d,true);
  view.setUint32(4,1,true);
  view.setUint32(8,1,true);
  view.setInt16(34,32767,true);
  view.setUint8(36,128);
  const {data,count} = decodeMaikoPerformance(previous);
  assert.equal(count,1);
  assert.deepEqual(Array.from(data.slice(9,18)),[0,0,1,0,0,1,0,0,1]);
  assert.ok(Math.abs(data[18]-128/255)<0.00001);
});
test("the greeting hand stays in front and swings in depth",()=>{
  const {data,count} = decodeMaikoPerformance(buffer);
  const sum = new Float64Array(6);
  let handPoints = 0;
  // Select the lowered hand in the rest shape, tracking these same surface
  // samples through both poses. Browser +Z faces the viewer.
  for(let i=0;i<count;i++) {
    const k=i*20;
    if(data[k]>0.45 && data[k+1]>-0.60 && data[k+1]<-0.28) {
      handPoints++;
      for(let j=0;j<6;j++) sum[j]+=data[k+3+j];
    }
  }
  assert.ok(handPoints>500,"Expected enough hand samples to check the gesture");
  const mean = sum.map(value=>value/handPoints);
  assert.ok(mean[2]>0.26 && mean[5]>0.26,"Both greeting poses must be in front");
  assert.ok(Math.abs(mean[5]-mean[2])>Math.abs(mean[3]-mean[0])*3,"Hand must swing forward/back rather than sideways from the head");
});
test("truncated animation data is rejected",()=>{
  assert.throws(()=>decodeMaikoPerformance(buffer.slice(0,-1)));
  assert.throws(()=>decodeMaikoPerformance(new ArrayBuffer(8)));
});
