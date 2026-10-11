import {MaikoParticleMotion,MAIKO_PARTICLE_LIMIT,MAIKO_PARTICLE_CORE_LIMIT,MAIKO_PARTICLE_ROAM_THRESHOLD,MAIKO_PARTICLE_AGITATION,MAIKO_PARTICLE_SPRING,MAIKO_PARTICLE_DRAG,MAIKO_PARTICLE_SPEED,MAIKO_PARTICLE_REPULSION} from "./maikoParticleMotion";

const vertexSource=`#version 300 es
void main() {
  vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  gl_Position=vec4(p*2.0-1.0,0.0,1.0);
}`;
const fragmentSource=`#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uRest;
uniform highp sampler2D uNeighbours;
uniform highp sampler2D uOffsets;
uniform highp sampler2D uVelocity;
uniform int uWidth;
uniform int uCount;
uniform float uContact;
uniform float uDelta;
uniform float uTime;
layout(location=0) out vec4 offsets;
layout(location=1) out vec4 velocity;
ivec2 address(int index) {return ivec2(index%uWidth,index/uWidth);}
void main() {
  ivec2 uv=ivec2(gl_FragCoord.xy);
  int index=uv.y*uWidth+uv.x;
  if(index>=uCount) {offsets=vec4(0.0);velocity=vec4(0.0);return;}
  vec4 rest=texelFetch(uRest,uv,0);
  vec3 p=texelFetch(uOffsets,uv,0).xyz;
  vec3 v=texelFetch(uVelocity,uv,0).xyz;
  vec3 neighbours=texelFetch(uNeighbours,uv,0).xyz;
  float phase=rest.w*6.2831853;
  float time=uTime*${MAIKO_PARTICLE_SPEED.toFixed(1)};
  float activity=mix(0.1,1.0,step(${MAIKO_PARTICLE_ROAM_THRESHOLD.toFixed(1)},rest.w));
  vec3 thermal=vec3(sin(time*3.1+phase*13.0),cos(time*2.7+phase*19.0),sin(time*3.7+phase*23.0))*${MAIKO_PARTICLE_AGITATION.toFixed(1)}*activity;
  vec3 force=-p*${MAIKO_PARTICLE_SPRING.toFixed(1)}+thermal;
  for(int n=0;n<3;n++) {
    int other=int(neighbours[n]);
    if(other<0) continue;
    ivec2 coord=address(other);
    vec3 delta=rest.xyz+p-texelFetch(uRest,coord,0).xyz-texelFetch(uOffsets,coord,0).xyz;
    float distance=length(delta);
    if(distance>=uContact) continue;
    if(distance<0.0000001) {force.x+=(index<other?-1.0:1.0)*uContact*80.0;continue;}
    force+=delta*(uContact-distance)*${MAIKO_PARTICLE_REPULSION.toFixed(1)}/distance;
  }
  v=(v+force*uDelta)*exp(-${MAIKO_PARTICLE_DRAG.toFixed(1)}*uDelta);
  p+=v*uDelta;
  float radius=length(p);
  float limit=mix(${MAIKO_PARTICLE_CORE_LIMIT.toFixed(3)},${MAIKO_PARTICLE_LIMIT.toFixed(3)},step(${MAIKO_PARTICLE_ROAM_THRESHOLD.toFixed(1)},rest.w));
  if(radius>limit) {p*=limit/radius;v*=0.55;}
  offsets=vec4(p,1.0);
  velocity=vec4(v,1.0);
}`;

/** Ping-pong float textures keep every point's spring/collision state on the GPU. */
export function createMaikoParticleGpu(gl:WebGL2RenderingContext,data:Float32Array,count:number) {
  if(!gl.getExtension("EXT_color_buffer_float")) throw new Error("Float particle simulation unavailable");
  const width=512,height=Math.ceil(count/width),graph=new MaikoParticleMotion(data,count,0);
  const shaders:WebGLShader[]=[],textures:WebGLTexture[]=[],frames:WebGLFramebuffer[]=[];
  const program=gl.createProgram(),vao=gl.createVertexArray();
  if(!program||!vao) throw new Error("Unable to allocate particle simulation");
  const dispose=()=>{for(const f of frames)gl.deleteFramebuffer(f);for(const t of textures)gl.deleteTexture(t);for(const s of shaders)gl.deleteShader(s);gl.deleteProgram(program);gl.deleteVertexArray(vao);};
  try {
    for(const [type,source] of [[gl.VERTEX_SHADER,vertexSource],[gl.FRAGMENT_SHADER,fragmentSource]] as const) {
      const shader=gl.createShader(type);
      if(!shader) throw new Error("Unable to allocate particle shader");
      shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)||"Particle shader failed");
      gl.attachShader(program,shader);
    }
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)||"Particle program failed");
    const texture=(values:Float32Array|null)=>{
      const t=gl.createTexture();if(!t)throw new Error("Unable to allocate particle texture");
      textures.push(t);gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,width,height,0,gl.RGBA,gl.FLOAT,values);
      return t;
    };
    const rest=new Float32Array(width*height*4),links=new Float32Array(rest.length).fill(-1);
    for(let i=0;i<count;i++) {
      for(let j=0;j<3;j++) {rest[i*4+j]=data[i*16+j];links[i*4+j]=graph.neighbours[i*3+j];}
      rest[i*4+3]=data[i*16+15];
    }
    const restTexture=texture(rest),neighbours=texture(links);
    const states=Array.from({length:2},()=>({offsets:texture(null),velocity:texture(null)}));
    for(const state of states) {
      const f=gl.createFramebuffer();if(!f)throw new Error("Unable to allocate particle frame");
      frames.push(f);gl.bindFramebuffer(gl.FRAMEBUFFER,f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,state.offsets,0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,state.velocity,0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error("Particle framebuffer unavailable");
      gl.clearBufferfv(gl.COLOR,0,new Float32Array(4));gl.clearBufferfv(gl.COLOR,1,new Float32Array(4));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    const uniforms=Object.fromEntries(["uRest","uNeighbours","uOffsets","uVelocity","uWidth","uCount","uContact","uDelta","uTime"].map(name=>[name,gl.getUniformLocation(program,name)]));
    let current=0,accumulator=0;
    return {dispose,get texture(){return states[current].offsets;},advance(delta:number,time:number) {
      accumulator=Math.min(accumulator+Math.max(0,delta),1/15);
      if(accumulator<1/60)return;
      gl.useProgram(program);gl.bindVertexArray(vao);gl.viewport(0,0,width,height);
      gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.depthMask(false);
      gl.uniform1i(uniforms.uRest,0);gl.uniform1i(uniforms.uNeighbours,1);gl.uniform1i(uniforms.uOffsets,2);gl.uniform1i(uniforms.uVelocity,3);
      gl.uniform1i(uniforms.uWidth,width);gl.uniform1i(uniforms.uCount,count);gl.uniform1f(uniforms.uContact,graph.contact);
      gl.uniform1f(uniforms.uDelta,1/60);gl.uniform1f(uniforms.uTime,time);
      while(accumulator>=1/60) {
        const target=1-current;
        gl.bindFramebuffer(gl.FRAMEBUFFER,frames[target]);
        for(const [unit,t] of [restTexture,neighbours,states[current].offsets,states[current].velocity].entries()) {gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);}
        gl.drawArrays(gl.TRIANGLES,0,3);current=target;accumulator-=1/60;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindVertexArray(null);
    }};
  } catch(error) {gl.bindFramebuffer(gl.FRAMEBUFFER,null);dispose();throw error;}
}
