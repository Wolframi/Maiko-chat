import { MaikoParticleMotion, MaikoHover, maikoHoverWave, maikoCursorRepulsion, prepareMaikoParticleGraph, type MaikoParticleGraph, MAIKO_PARTICLE_ROAM_THRESHOLD, MAIKO_CURSOR_FALLOFF, MAIKO_CURSOR_STRENGTH, MAIKO_CURSOR_PULSE, MAIKO_CURSOR_SWIRL } from "./maikoParticleMotion";
import {createMaikoParticleGpu} from "./maikoParticleGpu";

export { chooseMaikoIntro, maikoIntroAsset, maikoIntroDuration, type MaikoIntro } from "./maikoIntro";
export const MAIKO_GROUND_Y = -1.2;
export const MAIKO_DANCE_SECONDS = 6;
export const chooseMaikoDanceStart = (duration:number,random:number) => Math.max(0,duration-MAIKO_DANCE_SECONDS)*clamp(random);

export function decodeMaikoDance(buffer: ArrayBuffer, limit = 84000) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 32 || view.getUint32(0,true) !== 0x4e414b4d || view.getUint32(4,true) !== 1) throw new Error("Invalid Maiko dance");
  const total=view.getUint32(8,true), bones=view.getUint32(12,true), frames=view.getUint32(16,true), fps=view.getUint32(20,true);
  const duration=view.getFloat32(24,true);
  if (!total || total>100000 || !bones || bones>255 || frames<2 || frames>1024 || !fps || fps>120 || !Number.isFinite(duration) || Math.abs(duration-(frames-1)/fps)>0.001 || buffer.byteLength!==32+total*21+bones*frames*24) throw new Error("Incomplete Maiko dance");
  const count=Math.min(total,Math.max(1,Math.floor(Number.isFinite(limit)?limit:total)));
  // position, normal, four joint indices, four weights, luminance, deterministic seed
  const data=new Float32Array(count*16);
  for(let i=0;i<count;i++) {
    const offset=32+Math.floor(i*total/count)*21, k=i*16;
    for(let j=0;j<3;j++) { data[k+j]=view.getInt16(offset+j*2,true)/8192; data[k+j+3]=view.getInt16(offset+6+j*2,true)/32767; }
    let sum=0;
    for(let j=0;j<4;j++) {
      const joint=view.getUint8(offset+12+j), weight=view.getUint8(offset+16+j);
      if(joint>=bones) throw new Error("Invalid Maiko joint");
      data[k+6+j]=joint; data[k+10+j]=weight/255; sum+=weight;
    }
    if(sum!==255) throw new Error("Invalid Maiko skin weights");
    data[k+14]=view.getUint8(offset+20)/255;
    data[k+15]=(Math.floor(i*total/count)*0.61803398875)%1;
  }
  const palette=new Float32Array(bones*frames*16);
  let offset=32+total*21;
  for(let i=0;i<bones*frames;i++) {
    for(let col=0;col<4;col++) for(let row=0;row<3;row++) { palette[i*16+col*4+row]=view.getInt16(offset,true)/4096; offset+=2; }
    palette[i*16+15]=1;
  }
  return {data,palette,count,bones,frames,fps,duration};
}
export type MaikoDance = ReturnType<typeof decodeMaikoDance>;
type PreparedMaikoDance = { dance:MaikoDance; graph:MaikoParticleGraph };
export async function prepareMaikoDance(buffer:ArrayBuffer,limit:number,signal?:AbortSignal):Promise<PreparedMaikoDance> {
  signal?.throwIfAborted();
  const dance=decodeMaikoDance(buffer,limit);
  const graph=await prepareMaikoParticleGraph(dance.data,dance.count,signal);
  signal?.throwIfAborted();
  return {dance,graph};
}
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const smooth=(a:number,b:number,t:number)=>{const x=clamp((t-a)/(b-a));return x*x*(3-2*x);};

export function maikoDanceFrame(dance: MaikoDance, time: number, motion = true, startSeconds=0) {
  const start=Math.min(Math.max(0,startSeconds),Math.max(0,dance.duration-MAIKO_DANCE_SECONDS));
  const seconds=!motion?0:Math.min(dance.duration,start+Math.max(0,Math.min(MAIKO_DANCE_SECONDS,time-1.1)));
  const frame=Math.min(dance.frames-1,seconds*dance.fps);
  const a=Math.floor(frame);
  return [a,Math.min(dance.frames-1,a+1),frame-a] as const;
}

/** Also used by the Canvas renderer and verification, with the same GPU palette. */
export function skinMaikoPoint(dance: MaikoDance, point: number, frame: readonly number[], result = new Float32Array(6), offsets?:Float32Array) {
  const k=point*16, d=dance.data;
  let ox=offsets?.[point*3]??0,oy=offsets?.[point*3+1]??0,oz=offsets?.[point*3+2]??0;
  // Keep movement tangent to the bind surface rather than puffing it outward.
  const outward=ox*d[k+3]+oy*d[k+4]+oz*d[k+5];
  ox-=d[k+3]*outward;oy-=d[k+4]*outward;oz-=d[k+5]*outward;
  result.fill(0);
  for(let j=0;j<4;j++) {
    const weight=d[k+10+j];
    if(!weight) continue;
    const a=(frame[0]*dance.bones+d[k+6+j])*16, b=(frame[1]*dance.bones+d[k+6+j])*16;
    for(let row=0;row<3;row++) {
      let p=0,n=0;
      for(let col=0;col<4;col++) {
        const v=dance.palette[a+col*4+row]*(1-frame[2])+dance.palette[b+col*4+row]*frame[2];
        p+=v*(col===3?1:d[k+col]+(col===0?ox:col===1?oy:oz));
        if(col<3) n+=v*d[k+3+col];
      }
      result[row]+=p*weight; result[row+3]+=n*weight;
    }
  }
  const length=Math.hypot(result[3],result[4],result[5])||1;
  for(let j=3;j<6;j++) result[j]/=length;
  return result;
}

const vertexSource=`#version 300 es
precision highp float;
in vec3 aRest;
in vec3 aNormal;
in vec4 aJoints;
in vec4 aWeights;
in float aShade;
in float aSeed;
uniform highp sampler2D uPalette;
uniform highp sampler2D uOffsets;
uniform vec3 uFrame;
uniform vec2 uViewport;
uniform vec2 uPointer;
uniform float uTime;
uniform float uScale;
uniform float uDpr;
uniform float uMotion;
uniform float uExit;
uniform float uFocus;
uniform float uHoverTime;
uniform float uLayer;
out float vAlpha;
mat4 joint(float id,int frame) {
  int x=int(id)*4;
  return mat4(texelFetch(uPalette,ivec2(x,frame),0),texelFetch(uPalette,ivec2(x+1,frame),0),texelFetch(uPalette,ivec2(x+2,frame),0),texelFetch(uPalette,ivec2(x+3,frame),0));
}
void main() {
  mat4 skin=mat4(0.0);
  for(int j=0;j<4;j++) skin+=(joint(aJoints[j],int(uFrame.x))*(1.0-uFrame.z)+joint(aJoints[j],int(uFrame.y))*uFrame.z)*aWeights[j];
  vec3 offset=texelFetch(uOffsets,ivec2(gl_VertexID%512,gl_VertexID/512),0).xyz;
  offset-=aNormal*dot(offset,aNormal);
  vec3 anchor=(skin*vec4(aRest,1.0)).xyz;
  float detailGain=1.0-smoothstep(0.25,0.75,anchor.y)*0.7;
  vec3 p=anchor+(mat3(skin)*offset)*uMotion*detailGain;
  p.y=max(p.y,${(MAIKO_GROUND_Y+0.001).toFixed(3)});
  vec3 normal=normalize(mat3(skin)*aNormal);
  float t=uTime;
  float phase=aSeed*6.2831853;
  float random=fract(sin(aSeed*127.1+0.731)*4375.85453);
  float angle=-0.06;
  float c=cos(angle),s=sin(angle);
  p=vec3(p.x*c-p.z*s,p.y,p.x*s+p.z*c);
  normal=vec3(normal.x*c-normal.z*s,normal.y,normal.x*s+normal.z*c);
  float delay=aSeed*0.18;
  float entry=mix(1.0,smoothstep(0.14+delay,0.95+delay,t),uMotion);
  float scatter=(1.0-entry)*(1.0-entry);
  float radius=min(1.32,min(uViewport.x,uViewport.y)/uScale*0.4);
  float latitude=1.0-2.0*random;
  float ring=sqrt(max(0.0,1.0-latitude*latitude));
  float spiral=phase+scatter*5.5+t*0.5;
  vec3 cloud=vec3(cos(spiral)*ring,latitude,sin(spiral)*ring)*radius*(0.88+0.12*fract(aSeed*59.7));
  p=mix(p,cloud,scatter);
  vec2 cursorDelta=p.xy*4.8/(4.8-p.z)-uPointer;
  float distance=length(cursorDelta);
  float proximity=exp(-distance*distance/${MAIKO_CURSOR_FALLOFF.toFixed(3)})*uFocus*uMotion*entry;
  float hoverRadius=0.04+fract(uHoverTime*0.75)*0.43;
  float hoverWave=exp(-pow((distance-hoverRadius)/0.04,2.0)-distance*distance/0.35)*uFocus*uMotion*entry;
  vec2 direction=distance>0.001?cursorDelta/distance:vec2(cos(phase),sin(phase));
  float cursorMobility=mix(0.025,1.0,step(${MAIKO_PARTICLE_ROAM_THRESHOLD.toFixed(1)},aSeed))*detailGain;
  p.xy+=direction*proximity*(${MAIKO_CURSOR_STRENGTH.toFixed(3)}+${MAIKO_CURSOR_PULSE.toFixed(3)}*sin(t*5.0+phase))*cursorMobility;
  p.xy+=vec2(-direction.y,direction.x)*proximity*cursorMobility*${MAIKO_CURSOR_SWIRL.toFixed(3)}*sin(uHoverTime*4.0+phase);
  p.z+=proximity*sin(t*6.0+phase)*0.005*cursorMobility;
  p.y=max(p.y,mix(-radius,${(MAIKO_GROUND_Y+0.001).toFixed(3)},entry));
  float front=max(0.0,normal.z);
  float texture=0.045+0.955*pow(aShade,0.65);
  float surface=(0.05+sqrt(front)*1.28)*texture;
  float cloudAlpha=0.13+max(0.0,cloud.z/radius)*0.32;
  float sweep=exp(-pow((p.y-(-1.35+(t-0.8)*3.0))*7.0,2.0))*uMotion;
  float hoverLight=(proximity*0.45+hoverWave*0.8)*texture*sqrt(front);
  vAlpha=min(1.0,mix(cloudAlpha,surface,entry)+sweep*front*0.25+hoverLight);
  vAlpha*=mix(1.0,smoothstep(0.0,0.15,t),uMotion);
  float size=mix(1.3,max(1.05,uScale*0.0041),entry)*(0.85+aSeed*0.3);
  float roaming=step(${MAIKO_PARTICLE_ROAM_THRESHOLD.toFixed(1)},aSeed)*entry*uMotion;
  float sparkle=0.5+0.5*sin(t*7.0+phase*11.0);
  size*=1.0+roaming*0.35+hoverWave*0.25;
  vAlpha*=mix(1.0,0.8+0.2*sparkle,roaming);
  if(uLayer>0.5) {
    float orbit=phase+t*(0.45+random*0.4);
    float formation=1.0-smoothstep(0.65,1.4,t);
    // A real horizontal disk shares the sole height and camera projection.
    // Its outer ring and surface grains give the feet a visible support plane.
    float rim=step(0.45,random);
    float floorRadius=mix(sqrt(fract(aSeed*59.7))*1.06,1.08+fract(aSeed*93.1)*0.024,rim);
    vec3 base=vec3(cos(orbit)*floorRadius,${MAIKO_GROUND_Y.toFixed(1)},sin(orbit)*floorRadius);
    vec3 orbitA=vec3(cos(orbit),sin(orbit)*0.7071,sin(orbit)*0.7071);
    vec3 orbitB=vec3(cos(orbit)*0.7071,sin(orbit),cos(orbit)*0.7071);
    p=mix(base,mix(orbitA,orbitB,step(0.5,random))*radius*1.05,formation);
    float floorAlpha=mix(0.075,0.38,rim);
    float orbitAlpha=0.1+pow(max(0.0,sin(phase*11.0+t*2.0)),8.0)*0.3;
    vAlpha=mix(floorAlpha,orbitAlpha,formation)*uMotion*smoothstep(0.0,0.25,t);
    size=mix(1.0,1.25,rim);
  }
  float dissolve=smoothstep(7.3,8.05,t)*uMotion;
  dissolve=max(dissolve,uExit);
  float spread=dissolve*dissolve*(0.45+random*1.4);
  p+=vec3(cos(phase+t),sin(phase+t)+0.4,sin(phase*3.0))*spread;
  vAlpha*=1.0-dissolve;
  float perspective=4.8/(4.8-p.z);
  gl_Position=vec4(p.xy*perspective*uScale*2.0/uViewport,-p.z/4.0,1.0);
  gl_PointSize=size*uDpr*perspective;
}`;
const fragmentSource=`#version 300 es
precision mediump float;
in float vAlpha;
out vec4 color;
void main() {
  float radius=length(gl_PointCoord-0.5);
  if(radius>0.5||vAlpha<0.025) discard;
  color=vec4(vec3(1.0),(1.0-smoothstep(0.28,0.5,radius))*vAlpha);
}`;

export function createMaikoRenderer(canvas: HTMLCanvasElement, buffer: ArrayBuffer, limit: number, startRandom=0, prepared?:PreparedMaikoDance) {
  const dance=prepared?.dance??decodeMaikoDance(buffer,limit);
  const startSeconds=chooseMaikoDanceStart(dance.duration,startRandom);
  const gl=canvas.getContext("webgl2",{alpha:true,antialias:false,premultipliedAlpha:true,powerPreference:"low-power"});
  if(!gl) throw new Error("WebGL2 unavailable");
  const shaders: WebGLShader[]=[];
  const program=gl.createProgram(), vertices=gl.createBuffer(), texture=gl.createTexture();
  if(!program||!vertices||!texture) throw new Error("Unable to allocate Maiko renderer");
  let particles:ReturnType<typeof createMaikoParticleGpu>|null=null;
  const dispose=()=>{particles?.dispose();gl.deleteTexture(texture);gl.deleteBuffer(vertices);gl.deleteProgram(program);for(const shader of shaders) gl.deleteShader(shader);};
  try {
    for(const [type,source] of [[gl.VERTEX_SHADER,vertexSource],[gl.FRAGMENT_SHADER,fragmentSource]] as const) {
      const shader=gl.createShader(type);
      if(!shader) throw new Error("Unable to allocate shader");
      shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)||"Shader compilation failed");
      gl.attachShader(program,shader);
    }
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)||"Shader linking failed");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER,vertices);gl.bufferData(gl.ARRAY_BUFFER,dance.data,gl.STATIC_DRAW);
    let offset=0;
    for(const [name,size] of [["aRest",3],["aNormal",3],["aJoints",4],["aWeights",4],["aShade",1],["aSeed",1]] as const) {
      const location=gl.getAttribLocation(program,name);
      gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,64,offset*4);offset+=size;
    }
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,dance.bones*4,dance.frames,0,gl.RGBA,gl.FLOAT,dance.palette);
    if(gl.getError()!==gl.NO_ERROR) throw new Error("Unable to upload Maiko palette");
    particles=createMaikoParticleGpu(gl,dance.data,dance.count,prepared?.graph);
    const uniforms=Object.fromEntries(["uPalette","uOffsets","uFrame","uViewport","uPointer","uTime","uScale","uDpr","uMotion","uExit","uFocus","uHoverTime","uLayer"].map(name=>[name,gl.getUniformLocation(program,name)]));
    gl.useProgram(program);
    gl.uniform1i(uniforms.uPalette,0);
    gl.uniform1i(uniforms.uOffsets,1);
    gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.clearColor(0,0,0,0);
    let lastTime=0;
    const hover=new MaikoHover();
    return {dispose,startSeconds,draw(width:number,height:number,dpr:number,time:number,motion:boolean,exit:number,pointer:{x:number;y:number}|null) {
      const scale=Math.min(width*0.44,height*0.31,285);
      const dt=Math.min(0.05,Math.max(0,time-lastTime));lastTime=time;
      if(motion) particles?.advance(dt,time);
      gl.useProgram(program);gl.bindVertexArray(null);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,particles!.texture);
      gl.enable(gl.BLEND);
      gl.depthMask(true);
      hover.step(width,height,scale,dt,time,pointer,motion);
      gl.viewport(0,0,canvas.width,canvas.height);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.uniform3fv(uniforms.uFrame,maikoDanceFrame(dance,time,motion,startSeconds));
      gl.uniform2f(uniforms.uViewport,width,height);gl.uniform2f(uniforms.uPointer,hover.position.x,hover.position.y);
      gl.uniform1f(uniforms.uFocus,hover.focus);gl.uniform1f(uniforms.uHoverTime,hover.age);gl.uniform1f(uniforms.uTime,time);gl.uniform1f(uniforms.uScale,scale);gl.uniform1f(uniforms.uDpr,dpr);
      gl.uniform1f(uniforms.uMotion,motion?1:0);gl.uniform1f(uniforms.uExit,exit);
      gl.uniform1f(uniforms.uLayer,1);gl.disable(gl.DEPTH_TEST);gl.depthMask(false);gl.drawArrays(gl.POINTS,0,Math.min(dance.count,4200));
      gl.uniform1f(uniforms.uLayer,0);gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.drawArrays(gl.POINTS,0,dance.count);
    }};
  } catch(error) {dispose();throw error;}
}

export function createMaikoCanvasRenderer(canvas: HTMLCanvasElement, buffer: ArrayBuffer, limit: number, startRandom=0, prepared?:PreparedMaikoDance) {
  const ctx=canvas.getContext("2d",{alpha:true});
  if(!ctx) throw new Error("Canvas unavailable");
  const dance=prepared?.dance??decodeMaikoDance(buffer,limit), point=new Float32Array(6),anchor=new Float32Array(6);
  const startSeconds=chooseMaikoDanceStart(dance.duration,startRandom),particles=new MaikoParticleMotion(dance.data,dance.count,undefined,prepared?.graph);
  const batches:number[][]=Array.from({length:16},()=>[]);
  let lastTime=0;
  const hover=new MaikoHover();
  return {dispose() {},startSeconds,draw(width:number,height:number,dpr:number,time:number,motion:boolean,exit:number,pointer:{x:number;y:number}|null) {
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    const scale=Math.min(width*0.44,height*0.31,285), frame=maikoDanceFrame(dance,time,motion,startSeconds);
    const dt=Math.min(0.05,Math.max(0,time-lastTime));lastTime=time;
    hover.step(width,height,scale,dt,time,pointer,motion);
    const focus=hover.focus,smoothPointer=hover.position;
    if(motion) particles.advance(dt,time);
    const angle=-0.06,c=Math.cos(angle),s=Math.sin(angle);
    const dissolve=Math.max(exit,motion?smooth(7.3,8.05,time):0);
    const radius=Math.min(1.32,Math.min(width,height)/scale*0.4);
    // Match the GPU's horizontal platform in the Canvas fallback too.
    if(motion&&time>0.65) {
      ctx.fillStyle="#ffffff";
      ctx.globalAlpha=smooth(0.65,1.4,time)*(1-dissolve)*0.32;
      ctx.beginPath();
      for(let i=0;i<1800;i++) {
        const seed=(i*0.61803398875)%1,phase=seed*Math.PI*2+time*0.6;
        const random=(i*0.754877666)%1,rim=random>0.45;
        const r=rim?1.08+((seed*93.1)%1)*0.024:Math.sqrt((seed*59.7)%1)*1.06;
        const z=Math.sin(phase)*r,perspective=4.8/(4.8-z);
        const x=width/2+Math.cos(phase)*r*perspective*scale,y=height/2-MAIKO_GROUND_Y*perspective*scale;
        const size=rim?0.7:0.35;
        ctx.moveTo(x+size,y);ctx.arc(x,y,size,0,Math.PI*2);
      }
      ctx.fill();ctx.globalAlpha=1;
    }
    for(const batch of batches) batch.length=0;
    for(let i=0;i<dance.count;i++) {
      skinMaikoPoint(dance,i,frame,point,motion?particles.offsets:undefined);
      skinMaikoPoint(dance,i,frame,anchor);
      const detailGain=1-smooth(0.25,0.75,anchor[1])*0.7;
      for(let axis=0;axis<3;axis++) point[axis]=anchor[axis]+(point[axis]-anchor[axis])*detailGain;
      point[1]=Math.max(point[1],MAIKO_GROUND_Y+0.001);
      const k=i*16,seed=dance.data[k+15],phase=seed*Math.PI*2;
      const hash=Math.sin(seed*127.1+0.731)*4375.85453,random=hash-Math.floor(hash);
      const entry=motion?smooth(0.14+seed*0.18,0.95+seed*0.18,time):1,scatter=(1-entry)**2;
      const latitude=1-2*random,ring=Math.sqrt(Math.max(0,1-latitude*latitude)),spiral=phase+scatter*5.5+time*0.5;
      let x=(point[0]*c-point[2]*s)*(1-scatter)+Math.cos(spiral)*ring*radius*scatter;
      let y=point[1]*(1-scatter)+latitude*radius*scatter;
      let z=(point[0]*s+point[2]*c)*(1-scatter)+Math.sin(spiral)*ring*radius*scatter;
      const front=Math.max(0,point[3]*s+point[5]*c),shade=0.045+0.955*dance.data[k+14]**0.65;
      const cursorX=x*4.8/(4.8-z)-smoothPointer.x,cursorY=y*4.8/(4.8-z)-smoothPointer.y;
      const proximity=Math.exp(-(cursorX*cursorX+cursorY*cursorY)/MAIKO_CURSOR_FALLOFF)*focus*entry*(motion?1:0);
      const hoverWave=maikoHoverWave(Math.hypot(cursorX,cursorY),hover.age,focus)*entry*(motion?1:0);
      const push=maikoCursorRepulsion(cursorX,cursorY,seed,time,focus*entry*(motion?1:0)*detailGain,hover.age);
      const mobility=(seed>=MAIKO_PARTICLE_ROAM_THRESHOLD?1:0.025)*detailGain;
      x+=push[0];y+=push[1];z+=proximity*Math.sin(time*6+phase)*0.005*mobility;
      y=Math.max(y,-radius*(1-entry)+(MAIKO_GROUND_Y+0.001)*entry);
      const spread=dissolve*dissolve*(0.45+random*1.4);
      x+=Math.cos(phase+time)*spread;y+=(Math.sin(phase+time)+0.4)*spread;z+=Math.sin(phase*3)*spread;
      const perspective=4.8/(4.8-z);
      const roaming=seed>=MAIKO_PARTICLE_ROAM_THRESHOLD&&motion?entry:0,sparkle=0.5+0.5*Math.sin(time*7+phase*11);
      const hoverLight=(proximity*0.45+hoverWave*0.8)*shade*Math.sqrt(front);
      const alpha=Math.min(1,((0.05+Math.sqrt(front)*1.28)*shade*entry+(0.13+Math.max(0,Math.sin(spiral)*ring)*0.32)*(1-entry)+hoverLight))*(1-dissolve)*(motion?smooth(0,0.15,time):1)*(1-roaming*(0.2-0.2*sparkle));
      if(alpha<0.025) continue;
      const bucket=Math.min(15,Math.floor(alpha*16));
      batches[bucket].push(width/2+x*perspective*scale,height/2-y*perspective*scale,Math.max(0.6,scale*0.00205)*perspective*(1+roaming*0.35+hoverWave*0.25));
    }
    ctx.fillStyle="#ffffff";
    for(let b=0;b<batches.length;b++) {
      ctx.globalAlpha=(b+1)/16;ctx.beginPath();
      const batch=batches[b];
      for(let j=0;j<batch.length;j+=3) {ctx.moveTo(batch[j]+batch[j+2],batch[j+1]);ctx.arc(batch[j],batch[j+1],batch[j+2],0,Math.PI*2);}
      ctx.fill();
    }
    ctx.globalAlpha=1;
  }};
}
