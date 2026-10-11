import {test} from "node:test";
import assert from "node:assert/strict";
import {MaikoParticleMotion,MaikoHover,MAIKO_PARTICLE_LIMIT,MAIKO_PARTICLE_CORE_LIMIT,maikoCursorRepulsion,MAIKO_CURSOR_STRENGTH,MAIKO_CURSOR_PULSE,MAIKO_CURSOR_SWIRL} from "../src/lib/maikoParticleMotion";

test("nearby particles repel and their surface springs keep the silhouette bounded",()=>{
  const data=new Float32Array(32);data[0]=-0.0005;data[16]=0.0005;data[15]=0.94;data[31]=0.96;
  const particles=new MaikoParticleMotion(data,2,0);
  for(let i=0;i<240;i++) particles.step(1/60,i/60);
  const separation=0.001+particles.offsets[3]-particles.offsets[0];
  assert.ok(separation>0.01,`Expected actual mutual repulsion, got ${separation}`);
  for(const k of [0,3]) assert.ok(Math.hypot(...particles.offsets.slice(k,k+3))<=MAIKO_PARTICLE_LIMIT+1e-6);
});
test("independent particle motion continues when the cursor is absent",()=>{
  const data=new Float32Array(32);data[0]=-1;data[16]=1;data[31]=0.95;
  const particles=new MaikoParticleMotion(data,2);
  for(let i=0;i<60;i++) particles.advance(1/60,i/60);
  const first=particles.offsets.slice();
  for(let i=60;i<90;i++) particles.advance(1/60,i/60);
  assert.ok(first.some((v,i)=>Math.abs(v-particles.offsets[i])>0.005));
  assert.ok(first.some(v=>Math.abs(v)>0.005));
  for(let i=0;i<600;i++) particles.advance(4,i);
  assert.ok(particles.offsets.every(Number.isFinite));
  for(const k of [0,3]) assert.ok(Math.hypot(...particles.offsets.slice(k,k+3))<=MAIKO_PARTICLE_LIMIT+1e-6);
  assert.ok(Math.hypot(...particles.offsets.slice(0,3))<=MAIKO_PARTICLE_CORE_LIMIT+1e-6,"Dense core must stay sharp");
});
test("cursor movement preserves the detailed core while accent particles react",()=>{
  const core=maikoCursorRepulsion(0.04,0.02,0.3,2,1),accent=maikoCursorRepulsion(0.04,0.02,0.95,2,1);
  assert.ok(Math.hypot(...core)<0.002);
  assert.ok(Math.hypot(...accent)>0.02);
});
test("cursor pushes particles outward, stays bounded and returns when focus fades",()=>{
  for(const seed of [0.37,0.95]) for(const [x,y] of [[0,0],[0.04,0],[0,0.04],[-0.04,-0.04],[1,1]]) {
    const push=maikoCursorRepulsion(x,y,seed,2,1,0.8);
    assert.ok(push.every(Number.isFinite));
    assert.ok(Math.hypot(...push)<=Math.hypot(MAIKO_CURSOR_STRENGTH+MAIKO_CURSOR_PULSE,MAIKO_CURSOR_SWIRL)+1e-6);
    if(x||y) assert.ok(push[0]*x+push[1]*y>=0);
    assert.ok(maikoCursorRepulsion(x,y,seed,2,0,0.8).every(v=>v===0));
  }
});
test("hover animation starts on entering the mascot and fades on leaving",()=>{
  const hover=new MaikoHover();
  for(let i=0;i<30;i++)hover.step(1000,900,250,1/60,2+i/60,{x:500,y:400},true);
  assert.ok(hover.focus>0.95&&hover.age>0.4);
  for(let i=0;i<60;i++)hover.step(1000,900,250,1/60,3+i/60,{x:0,y:0},true);
  assert.ok(hover.focus<0.001);
  hover.step(1000,900,250,1/60,5,{x:500,y:400},true);
  assert.equal(hover.age,0);
});
