// A compact, local take on the center-out scramble/reverse reveal in
// https://codepen.io/juliangarnier/pen/vEyYdXN. No remote scripts are needed.
window.createStatusText = function createStatusText(source) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const track = document.createElement('span');
  const visual = document.createElement('span');
  track.className = 'status-text';
  visual.className = 'status-text-visual';
  visual.setAttribute('aria-hidden', 'true');
  source.before(track);
  track.append(source, visual);
  source.classList.add('status-text-source');
  // The original element always holds the complete, accessible status. Only
  // the aria-hidden visual layer gets scrambled; live regions remain quiet.
  let text = source.textContent;
  visual.textContent = text;
  let frame = 0, complete, pending = Promise.resolve(true), widthAnimation;
  const measure = document.createElement('canvas').getContext('2d');
  const glyphs = '░▒▓';

  function stop(finished) {
    cancelAnimationFrame(frame);
    frame = 0;
    widthAnimation?.cancel();
    widthAnimation = undefined;
    track.style.removeProperty('width');
    delete track.dataset.animating;
    if (finished) visual.textContent = text;
    complete?.(finished);
    complete = undefined;
  }

  function set(next, { immediate = false } = {}) {
    if (next === text) return pending;
    const old = text;
    const oldWidth = track.getBoundingClientRect().width;
    stop(false);
    text = next;
    source.textContent = next;
    if (immediate || reducedMotion.matches || document.hidden) {
      visual.textContent = next;
      return pending = Promise.resolve(true);
    }
    const newWidth = source.getBoundingClientRect().width;
    const from = Array.from(old), to = Array.from(next);
    const count = Math.max(from.length, to.length);
    const center = (count - 1) / 2;
    const font = getComputedStyle(source);
    measure.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
    const slots = Array.from({ length: count }, (_, index) => {
      const slot = document.createElement('span');
      slot.className = 'status-text-glyph';
      slot.style.width = `${measure.measureText(to[index] || from[index] || ' ').width}px`;
      slot.textContent = from[index] || ' ';
      return slot;
    });
    visual.replaceChildren(...slots);
    track.dataset.animating = 'true';
    track.style.width = `${newWidth}px`;
    widthAnimation = track.animate([{ width: `${oldWidth}px` }, { width: `${newWidth}px` }], {
      duration: next ? 600 : 260, delay: next ? 0 : 340,
      easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards',
    });
    pending = new Promise(resolve => { complete = resolve; });
    const start = performance.now();
    let lastTick = -1;
    function tick(now) {
      const elapsed = now - start;
      if (elapsed >= 600) { stop(true); return; }
      // Approximately 23 updates/second, with a gentle center-out settling wave.
      const step = Math.floor(elapsed / 44);
      if (step !== lastTick) {
        lastTick = step;
        for (let i = 0; i < count; i++) {
          const distance = Math.abs(i - center) / Math.max(1, center);
          const settle = 210 + distance * 300;
          const target = to[i] || ' ';
          const initial = from[i] || ' ';
          const scrambling = elapsed >= distance * 90 && elapsed < settle;
          slots[i].textContent = elapsed >= settle ? target : scrambling && (initial !== ' ' || target !== ' ')
            ? glyphs[(step + i * 7) % glyphs.length] : initial;
          slots[i].style.opacity = next ? '1' : elapsed >= settle ? '0' : '1';
        }
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return pending;
  }

  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) stop(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(true); });
  return { set };
};
