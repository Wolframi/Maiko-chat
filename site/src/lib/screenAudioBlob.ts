// Adapted from the Hyperplexed CodePen supplied by the user:
// https://codepen.io/Hyperplexed/pen/wvbyoLJ
const vertexShaderSource = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision mediump float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_audioData;

vec2 hash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
                 dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
                 dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}

vec3 getGradientColor(float t) {
  vec3 blue = vec3(22.0, 72.0, 238.0) / 255.0;
  vec3 sky = vec3(12.0, 160.0, 255.0) / 255.0;
  vec3 cyan = vec3(80.0, 242.0, 235.0) / 255.0;
  float cycle = fract(t) * 4.0;
  float blend = smoothstep(0.0, 1.0, fract(cycle));
  if (cycle < 1.0) return mix(blue, sky, blend);
  if (cycle < 2.0) return mix(sky, cyan, blend);
  if (cycle < 3.0) return mix(cyan, sky, blend);
  return mix(sky, blue, blend);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv = uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  float radius = 0.45 + u_audioData * 0.36;
  float dist = length(uv) - radius;
  float motion = 0.45 + u_audioData * 0.8;
  float n = noise(uv * 4.0 + vec2(u_time * 0.5, u_time * 0.5)) * 0.08 * motion;
  n += noise(uv * 8.0 + vec2(u_time * 0.3, -u_time * 0.3)) * 0.04 * motion;
  float boundary = dist + n;
  float softness = max(0.012, 2.0 / u_resolution.y);
  float edge = 1.0 - smoothstep(0.0, softness, boundary);
  float gradientPosition = fract(uv.x * 0.3 + uv.y * 0.1 - u_time * 0.035 + 0.28);
  vec3 color = getGradientColor(gradientPosition);
  float depth = clamp(length(uv) / radius, 0.0, 1.0);
  color *= 1.05 - depth * 0.4;
  float highlight = exp(-length((uv - vec2(-0.18, 0.22)) * vec2(1.0, 1.4)) * 6.0);
  color = mix(color, vec3(0.75, 0.98, 1.0), highlight * 0.8);
  float rim = exp(-abs(boundary + 0.022) * 70.0) * 0.25;
  color += vec3(0.18, 0.75, 1.0) * rim;
  float glow = exp(-max(boundary, 0.0) * 12.0) * (0.04 + u_audioData * 0.12);
  float alpha = max(edge, glow);
  vec3 light = mix(vec3(0.06, 0.5, 0.95) * glow, color, edge);
  gl_FragColor = vec4(light, alpha);
}
`;

export function createScreenAudioBlob(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;

  function createShader(type: number, source: string) {
    const shader = gl!.createShader(type);
    if (!shader) return null;
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) return shader;
    gl!.deleteShader(shader);
    return null;
  }

  function createResources() {
    const vertex = createShader(gl!.VERTEX_SHADER, vertexShaderSource);
    const fragment = createShader(gl!.FRAGMENT_SHADER, fragmentShaderSource);
    const program = gl!.createProgram();
    const buffer = gl!.createBuffer();
    if (!vertex || !fragment || !program || !buffer) {
      gl!.deleteShader(vertex);
      gl!.deleteShader(fragment);
      gl!.deleteProgram(program);
      gl!.deleteBuffer(buffer);
      return null;
    }
    gl!.attachShader(program, vertex);
    gl!.attachShader(program, fragment);
    gl!.linkProgram(program);
    gl!.deleteShader(vertex);
    gl!.deleteShader(fragment);
    if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) {
      gl!.deleteProgram(program);
      gl!.deleteBuffer(buffer);
      return null;
    }
    gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
    ]), gl!.STATIC_DRAW);
    return {
      program,
      buffer,
      position: gl!.getAttribLocation(program, "a_position"),
      resolution: gl!.getUniformLocation(program, "u_resolution"),
      time: gl!.getUniformLocation(program, "u_time"),
      audio: gl!.getUniformLocation(program, "u_audioData"),
    };
  }

  let resources = createResources();
  if (!resources) return null;
  const lost = (event: Event) => event.preventDefault();
  const restored = () => { resources = createResources(); };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);

  return {
    render(time: number, audio: number) {
      if (!resources || gl.isContextLost()) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.useProgram(resources.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer);
      gl.enableVertexAttribArray(resources.position);
      gl.vertexAttribPointer(resources.position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(resources.resolution, width, height);
      gl.uniform1f(resources.time, time);
      gl.uniform1f(resources.audio, audio);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      if (resources) {
        gl.deleteBuffer(resources.buffer);
        gl.deleteProgram(resources.program);
      }
      // React Strict Mode reuses a connected canvas after effect cleanup.
      // Losing that context would break the next setup on the same element.
      if (!canvas.isConnected) gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
