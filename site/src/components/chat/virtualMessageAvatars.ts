// Keep one avatar at the visible bottom of each author streak. A streak can
// span unmounted Virtuoso items, so CSS sticky on an individual row cannot do it.
export function bindVirtualMessageAvatars(scroller: HTMLElement) {
  const observed = new Set<HTMLElement>();

  function update() {
    const viewport = scroller.getBoundingClientRect();
    const groups = new Map<string, { top: number; bottom: number; avatar: HTMLElement; origin: number; height: number }>();
    const avatars: HTMLElement[] = [];
    for (const block of scroller.querySelectorAll<HTMLElement>("[data-avatar-cluster]")) {
      const row = block.querySelector<HTMLElement>(".bubble-row");
      const avatar = row?.querySelector<HTMLElement>(":scope > .avatar");
      if (!row || !avatar) continue;
      if (block.hasAttribute("data-avatar-static")) continue;
      avatars.push(avatar);
      const rect = row.getBoundingClientRect();
      const photo = avatar.getBoundingClientRect();
      if (!photo.height) continue;
      const key = block.dataset.avatarCluster!;
      groups.set(key, {
        top: groups.get(key)?.top ?? rect.top,
        bottom: rect.bottom,
        avatar,
        origin: photo.top - (parseFloat(avatar.style.getPropertyValue("--message-avatar-offset")) || 0),
        height: photo.height,
      });
    }
    // Read all geometry before writing, without changing the measured row sizes.
    for (const avatar of avatars) avatar.style.setProperty("--message-avatar-visible", "hidden");
    for (const group of groups.values()) {
      if (group.bottom <= viewport.top || group.top >= viewport.bottom) continue;
      const top = Math.max(group.top, Math.min(group.bottom, viewport.bottom - 8) - group.height);
      group.avatar.style.setProperty("--message-avatar-offset", `${top - group.origin}px`);
      group.avatar.style.setProperty("--message-avatar-visible", "visible");
    }
  }

  const resize = new ResizeObserver(update);
  resize.observe(scroller);
  function observeRows() {
    const current = new Set(scroller.querySelectorAll<HTMLElement>("[data-avatar-cluster]"));
    for (const row of observed) {
      if (!current.has(row)) { resize.unobserve(row); observed.delete(row); }
    }
    for (const row of current) {
      if (!observed.has(row)) { resize.observe(row); observed.add(row); }
    }
    // Measure committed rows before paint without changing their layout.
    update();
  }
  const mutations = new MutationObserver(observeRows);
  mutations.observe(scroller, { childList: true, subtree: true });
  // Scroll events already run before animation callbacks. Deferring another
  // frame moves the avatar with its row first, then snaps it back into place.
  scroller.addEventListener("scroll", update, { passive: true });
  observeRows();
  return () => {
    resize.disconnect();
    mutations.disconnect();
    scroller.removeEventListener("scroll", update);
  };
}
