(() => {
  if (window.maikoDownloadRingsInitialized) return;
  const api = window.maikoDownloadProgress;
  if (!api) return;
  window.maikoDownloadRingsInitialized = true;
  const length = 2 * Math.PI * 20;
  const rings = new Map();
  let active = [], scheduled = false;
  const pathname = value => {
    try { const url = new URL(value, location.href); return url.origin + decodeURIComponent(url.pathname); }
    catch { return ''; }
  };
  function remove(element, entry) {
    entry.ring.remove();
    entry.overlay?.remove();
    entry.icons.forEach(([icon, hidden]) => { icon.hidden = hidden; });
    rings.delete(element);
  }
  function render() {
    scheduled = false;
    if (!active.length && !rings.size) return;
    const present = new Set();
    for (const element of document.querySelectorAll('.bubble__file-link, .bubble__image-btn, .bubble__video-btn, .bubble__album-cell')) {
      const media = element.querySelector('img, video');
      const path = pathname(element.href || media?.currentSrc || media?.src || '');
      const file = active.find(item => item.sourcePath === path);
      if (!file) continue;
      present.add(element);
      let entry = rings.get(element);
      if (entry && !entry.ring.isConnected) { remove(element, entry); entry = null; }
      if (!entry) {
        const ring = document.createElement('button');
        const isFile = element.classList.contains('bubble__file-link');
        ring.type = 'button'; ring.className = `upload-ring upload-ring--${isFile ? 'file' : 'media'} download-ring`;
        ring.title = 'Отменить скачивание';
        ring.innerHTML = '<svg class="upload-ring__svg" viewBox="0 0 48 48" aria-hidden="true"><circle class="upload-ring__bar" cx="24" cy="24" r="20"/></svg><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
        const icons = [...element.querySelectorAll(':scope > .bubble__file-icon, :scope > .bubble__download, :scope > .bubble__video-play')].map(icon => [icon, icon.hidden]);
        icons.forEach(([icon]) => { icon.hidden = true; });
        entry = { ring, icons, id: file.id };
        ring.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          void api.cancel(entry.id).catch(() => {});
        });
        if (isFile) element.prepend(ring);
        else {
          const overlay = document.createElement('span'); overlay.className = 'bubble__upload-overlay';
          overlay.append(ring); element.append(overlay); entry.overlay = overlay;
        }
        rings.set(element, entry);
      }
      entry.id = file.id;
      const ratio = file.total > 0 ? Math.min(1, file.received / file.total) : 0;
      const circle = entry.ring.querySelector('circle');
      const dash = String(length * (1 - Math.max(0.04, ratio)));
      if (circle.getAttribute('stroke-dashoffset') !== dash) {
        circle.setAttribute('stroke-dasharray', String(length)); circle.setAttribute('stroke-dashoffset', dash);
      }
      entry.ring.setAttribute('aria-label', file.total > 0 ? `Отменить скачивание (${Math.round(ratio * 100)}%)` : 'Отменить скачивание');
    }
    for (const [element, entry] of rings) if (!present.has(element) || !element.isConnected) remove(element, entry);
  }
  function schedule() {
    if (!scheduled) { scheduled = true; requestAnimationFrame(render); }
  }
  api.onState(state => { active = state; schedule(); });
  // Messages may arrive or be remounted while their native download is running.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  void api.state().then(state => { active = state; schedule(); }).catch(() => {});
})();
