import { chooseMaikoIntro, createMaikoCanvasRenderer, createMaikoRenderer, MAIKO_DANCE_SECONDS } from '../site/src/lib/maikoDance';

// All code and model bytes come from the installed application. The renderer is
// shared with HologramMaiko; startup never waits for a server to fetch a model.
const api = (window as Window & { maikoDesktop: {
  startupModel(intro: string): Promise<Uint8Array>;
  startupModelFinished(): Promise<void>;
  state(): Promise<{ phase: string; startupCovered?: boolean }>;
  onState(callback: (state: { phase: string; startupCovered?: boolean }) => void): void;
} }).maikoDesktop;
let canvas = document.getElementById('startup-model') as HTMLCanvasElement;
let phase = '', generation = 0;
let dispose = () => {};
const MINIMUM_INTRO_MS = 3000;
const finishIntro = () => { void api.startupModelFinished().catch(() => {}); };

async function start(token: number) {
  const intro = chooseMaikoIntro(Math.random());
  canvas.dataset.state = 'loading';
  try {
    const bytes = await api.startupModel(intro);
    if (token !== generation) return;
    const buffer = new Uint8Array(bytes).buffer;
    const random = Math.random();
    let renderer: ReturnType<typeof createMaikoRenderer>;
    try {
      renderer = createMaikoRenderer(canvas, buffer, innerWidth < 600 ? 40000 : 84000, random);
      canvas.dataset.renderer = 'webgl';
    } catch {
      // A canvas cannot switch from WebGL to 2D after acquiring a context.
      const replacement = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(replacement);
      canvas = replacement;
      renderer = createMaikoCanvasRenderer(canvas, buffer, innerWidth < 600 ? 7000 : 14000, random);
      canvas.dataset.renderer = 'canvas';
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let width = 1, height = 1, dpr = 1, raf = 0, last = 0, elapsed = 0;
    // Keep moving during a slow refresh. Ping-pong the dance without replaying
    // the entrance or jumping between the clip's unrelated end poses.
    const animationTime = () => {
      if (elapsed <= 1.1) return elapsed;
      const cycle = (elapsed - 1.1) % (MAIKO_DANCE_SECONDS * 2);
      return 1.1 + (cycle <= MAIKO_DANCE_SECONDS ? cycle : MAIKO_DANCE_SECONDS * 2 - cycle);
    };
    const draw = () => {
      canvas.dataset.elapsed = String(elapsed);
      renderer.draw(width, height, dpr, reduced.matches ? 1.2 : animationTime(), !reduced.matches, 0, null);
    };
    const loop = (now: number) => {
      elapsed += last ? Math.min((now - last) / 1000, .1) : 0;
      last = now;
      draw();
      raf = requestAnimationFrame(loop);
    };
    const resume = () => {
      cancelAnimationFrame(raf);
      last = 0;
      if (document.hidden) return;
      if (reduced.matches) draw(); else raf = requestAnimationFrame(loop);
    };
    const resize = () => {
      width = canvas.clientWidth; height = canvas.clientHeight;
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      draw();
    };
    const motionChanged = () => {
      if (reduced.matches) { clearTimeout(finishTimer); finishIntro(); }
      resume();
    };
    const lost = (event: Event) => {
      event.preventDefault();
      dispose();
      // Recreate the surface after a graphics reset; the byte source stays local.
      canvas.replaceWith(canvas.cloneNode());
      canvas = document.getElementById('startup-model') as HTMLCanvasElement;
      void start(++generation);
    };
    dispose = () => {
      clearTimeout(finishTimer);
      cancelAnimationFrame(raf); renderer.dispose();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', resume);
      reduced.removeEventListener('change', motionChanged);
      canvas.removeEventListener('webglcontextlost', lost);
    };
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', resume);
    reduced.addEventListener('change', motionChanged);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.dataset.state = 'ready';
    canvas.dataset.intro = intro;
    canvas.dataset.startedAt = String(Date.now());
    canvas.dataset.danceStart = String(renderer.startSeconds);
    resize(); resume();
    // The site loads in parallel. Count from the first model frame, so a warm
    // browser cache cannot dismiss the dance before it has been seen.
    if (reduced.matches) finishIntro();
    else finishTimer = setTimeout(finishIntro, MINIMUM_INTRO_MS);
  } catch (error) {
    if (token !== generation) return;
    canvas.dataset.state = 'error';
    finishIntro();
    console.warn('Local startup model unavailable', error);
  }
}

function render(state: { phase: string; startupCovered?: boolean }) {
  if (state.startupCovered) { canvas.hidden = true; return; }
  if (phase === state.phase) return;
  phase = state.phase;
  const token = ++generation;
  dispose(); dispose = () => {};
  canvas.hidden = phase !== 'loading';
  if (phase === 'loading') {
    // Let the shell finish loading so main can start the network request before
    // model decoding or first-time shader compilation occupies this renderer.
    const begin = () => { if (token === generation) void start(token); };
    if (document.readyState === 'complete') begin();
    else window.addEventListener('load', begin, { once: true });
  }
}
api.onState(render);
void api.state().then(render);
