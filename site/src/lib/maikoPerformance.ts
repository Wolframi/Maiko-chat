/** Interleaved GPU attributes: three positions, three posed normals, shade, seed. */
export function decodeMaikoPerformance(buffer: ArrayBuffer, limit = 84000) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== 0x46504b4d) throw new Error("Invalid Maiko performance");
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== 2) throw new Error("Invalid Maiko performance version");
  const stride = version === 2 ? 37 : 25;
  const total = view.getUint32(8, true);
  if (!total || total > 100000 || buffer.byteLength !== 12 + total * stride) throw new Error("Incomplete Maiko performance");
  const count = Math.min(total, Math.max(1, Math.floor(limit)));
  const data = new Float32Array(count * 20);
  for (let i = 0; i < count; i++) {
    const offset = 12 + Math.floor(i * total / count) * stride;
    for (let j = 0; j < 9; j++) data[i * 20 + j] = view.getInt16(offset + j * 2, true) / 8192;
    for (let j = 0; j < 9; j++) {
      const source = version === 2 ? j + 9 : j % 3 + 9;
      data[i * 20 + j + 9] = view.getInt16(offset + source * 2, true) / 32767;
    }
    data[i * 20 + 18] = view.getUint8(offset + stride - 1) / 255;
    data[i * 20 + 19] = (i * 0.61803398875) % 1;
  }
  return { data, count };
}

const vertexSource = `
precision highp float;
attribute vec3 aRest;
attribute vec3 aWaveA;
attribute vec3 aWaveB;
attribute vec3 aNormal;
attribute vec3 aNormalA;
attribute vec3 aNormalB;
attribute float aShade;
attribute float aSeed;
uniform vec2 uViewport;
uniform vec2 uPointer;
uniform float uTime;
uniform float uScale;
uniform float uDpr;
uniform float uMotion;
uniform float uExit;
uniform float uFocus;
uniform float uLayer;
varying float vAlpha;
void main() {
  float t = uTime;
  float lift = smoothstep(2.5, 3.0, t) * (1.0 - smoothstep(4.15, 4.75, t)) * uMotion;
  float wave = 0.5 + 0.5 * sin((t - 3.0) * 7.5);
  vec3 p = mix(aRest, mix(aWaveA, aWaveB, wave), lift);
  vec3 poseNormal = normalize(mix(aNormal,mix(aNormalA,aNormalB,wave),lift));
  float body = smoothstep(-1.1, 0.2, p.y);
  p.y += sin(t * 2.2) * 0.012 * body * uMotion;
  p.x += sin(t * 1.7) * 0.01 * body * uMotion;
  p += poseNormal * sin(t * 2.6 + aSeed * 80.0) * 0.0022 * uMotion;
  // Keep the face visible: a small welcome bow instead of a full spin.
  float angle = -0.1 + (sin(t * 1.2) * 0.075 + clamp(uPointer.x,-1.0,1.0) * uFocus * 0.09) * uMotion;
  float c = cos(angle), s = sin(angle);
  p = vec3(p.x*c-p.z*s, p.y, p.x*s+p.z*c);
  vec3 normal = vec3(poseNormal.x*c-poseNormal.z*s, poseNormal.y, poseNormal.x*s+poseNormal.z*c);
  float heightDelay = clamp((aRest.y+1.2)/2.4,0.0,1.0)*0.38;
  float delay = heightDelay + aSeed*0.2;
  float entry = mix(1.0, smoothstep(0.7+delay, 1.8+delay, t), uMotion);
  float scatter = 1.0-entry;
  float phase = aSeed*6.2831853;
  float random = fract(sin(aSeed*127.1+0.731)*4375.85453);
  float spiral = phase + scatter*5.5 + t*0.5;
  float sphereRadius = min(1.32,min(uViewport.x,uViewport.y)/uScale*0.4);
  float latitude = 1.0-2.0*random;
  float ringRadius = sqrt(max(0.0,1.0-latitude*latitude));
  // Uniform latitudes and one shared XYZ radius produce a sphere, also on mobile.
  vec3 cloud = vec3(cos(spiral)*ringRadius,latitude,sin(spiral)*ringRadius);
  cloud *= sphereRadius*(0.88+0.12*fract(aSeed*59.7));
  p = mix(p, cloud, scatter*scatter);
  // A bounded shimmer under the cursor never pushes a hole through the surface.
  float proximity = exp(-dot(p.xy-uPointer,p.xy-uPointer)*12.0)*uFocus*uMotion*entry;
  p += normal * sin(t*5.0+aSeed*19.0)*proximity*0.008;
  float sweepY = -1.35 + (t-2.0)*2.0;
  float sweep = exp(-pow((p.y-sweepY)*7.0,2.0))*uMotion;
  float front = max(0.0, normal.z);
  float texture = 0.045 + 0.955*pow(aShade,0.65);
  float surfaceAlpha = (0.12+sqrt(front)*1.1)*texture;
  float cloudAlpha = 0.13+max(0.0,cloud.z/sphereRadius)*0.32;
  vAlpha = min(1.0,mix(cloudAlpha,surfaceAlpha,entry)+sweep*front*0.3+proximity*texture*0.28);
  vAlpha *= mix(1.0,smoothstep(0.0,0.2,t),uMotion);
  float size = mix(1.3, max(1.15,uScale*0.0052), entry)*(0.78+aSeed*0.44);
  if(uLayer>0.5) {
    // Great-circle orbits surround the sphere before settling at the feet.
    float orbit = phase+t*(0.45+random*0.4);
    float formation = 1.0-smoothstep(1.3,2.6,t);
    float radius = 0.8+random*0.35;
    vec3 base = vec3(cos(orbit)*radius,-1.28+sin(orbit)*0.07,sin(orbit)*radius*0.35);
    vec3 orbitA = vec3(cos(orbit),sin(orbit)*0.7071,sin(orbit)*0.7071);
    vec3 orbitB = vec3(cos(orbit)*0.7071,sin(orbit),cos(orbit)*0.7071);
    p = mix(base,mix(orbitA,orbitB,step(0.5,random))*sphereRadius*1.05,formation);
    float spark = step(0.86,random);
    p.y += spark*fract(aSeed*13.0+t*0.16)*2.6*(1.0-formation);
    p.x += spark*sin(t+phase)*0.16*(1.0-formation);
    vAlpha = (0.12+pow(max(0.0,sin(phase*11.0+t*2.0)),8.0)*0.42)*uMotion;
    vAlpha *= smoothstep(0.0,0.3,t)*(1.0-smoothstep(4.8,5.6,t));
    size = 1.0+pow(random,8.0)*2.0;
  }
  float exitSpread = uExit*uExit*(0.45+random*1.4);
  p.xy += vec2(cos(phase+t),sin(phase+t))*exitSpread;
  p.y += uExit*uExit*0.45;
  vAlpha *= 1.0-uExit;
  float perspective = 4.8/(4.8-p.z);
  gl_Position = vec4(p.xy * perspective * uScale * 2.0 / uViewport, -p.z/4.0, 1.0);
  gl_PointSize = size * uDpr * perspective;
}`;

const fragmentSource = `
precision mediump float;
varying float vAlpha;
void main() {
  float radius = length(gl_PointCoord-0.5);
  if(radius>0.5 || vAlpha<0.025) discard;
  float alpha = (1.0-smoothstep(0.28,0.5,radius))*vAlpha;
  gl_FragColor=vec4(vec3(1.0),alpha);
}`;

export function createMaikoRenderer(canvas: HTMLCanvasElement, buffer: ArrayBuffer, limit: number) {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "low-power" });
  if (!gl) throw new Error("WebGL unavailable");
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  const vertices = gl.createBuffer();
  if (!program || !vertices) throw new Error("Unable to allocate Maiko renderer");
  const dispose = () => {
    gl.deleteBuffer(vertices);
    gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
  };
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Unable to allocate shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Shader linking failed");
    gl.useProgram(program);
    const { data, count } = decodeMaikoPerformance(buffer, limit);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    let offset = 0;
    for (const [name, size] of [["aRest",3],["aWaveA",3],["aWaveB",3],["aNormal",3],["aNormalA",3],["aNormalB",3],["aShade",1],["aSeed",1]] as const) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 80, offset * 4);
      offset += size;
    }
    const uniforms = Object.fromEntries(["uViewport","uPointer","uTime","uScale","uDpr","uMotion","uExit","uFocus","uLayer"].map(name => [name, gl.getUniformLocation(program, name)]));
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0,0,0,0);
    let lastTime = 0, focus = 0;
    const smoothPointer = { x: 0, y: 0 };
    return {
      dispose,
      draw(width: number, height: number, dpr: number, time: number, motion: boolean, exit: number, pointer: {x:number;y:number} | null) {
        const scale = Math.min(width*0.44, height*0.31, 285);
        const dt = Math.min(0.05, Math.max(0,time-lastTime));
        lastTime = time;
        const smoothing = 1-Math.exp(-dt*8);
        focus += ((pointer && motion ? 1 : 0)-focus)*smoothing;
        if(pointer) {
          smoothPointer.x += ((pointer.x-width/2)/scale-smoothPointer.x)*smoothing;
          smoothPointer.y += ((height/2-pointer.y)/scale-smoothPointer.y)*smoothing;
        }
        gl.viewport(0,0,canvas.width,canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniform2f(uniforms.uViewport, width, height);
        gl.uniform2f(uniforms.uPointer,smoothPointer.x,smoothPointer.y);
        gl.uniform1f(uniforms.uFocus,focus);
        gl.uniform1f(uniforms.uTime, time);
        gl.uniform1f(uniforms.uScale, scale);
        gl.uniform1f(uniforms.uDpr, dpr);
        gl.uniform1f(uniforms.uMotion, motion ? 1 : 0);
        gl.uniform1f(uniforms.uExit, exit);
        gl.uniform1f(uniforms.uLayer,1);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.drawArrays(gl.POINTS,0,Math.min(count,2400));
        gl.uniform1f(uniforms.uLayer,0);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.drawArrays(gl.POINTS,0,count);
      },
    };
  } catch (error) { dispose(); throw error; }
}
