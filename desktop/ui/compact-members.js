// Support the currently deployed frontend too. Keep React's original rail in
// place; moving its DOM would break reconciliation when the chat changes.
// New frontends render their own responsive list and bypass this adapter.
(() => {
  if (globalThis.maikoCompactMembersInstalled) return;
  globalThis.maikoCompactMembersInstalled = true;
  const narrow = matchMedia('(max-width: 1100px)');
  let copy, list, original, signature, scheduled = false;

  function clear() {
    copy?.remove();
    list?.classList.remove('has-compact-members');
    copy = list = original = signature = undefined;
  }
  function sync() {
    scheduled = false;
    const rail = document.querySelector('.workspace > .member-rail');
    const invite = document.querySelector('.sidebar [data-guild-anchor="invite"]');
    const nativeList = document.querySelector('.sidebar__responsive-members:not([data-maiko-compact-members])');
    const target = invite?.closest('.sidebar__list--guild');
    if (!narrow.matches || !rail || !target || nativeList) { clear(); return; }
    if (list !== target || original !== rail || !copy?.isConnected) {
      clear();
      list = target;
      original = rail;
      copy = document.createElement('div');
      copy.className = 'sidebar__responsive-members';
      copy.dataset.maikoCompactMembers = '';
      invite.after(copy);
      list.classList.add('has-compact-members');
    }
    const next = rail.innerHTML;
    if (signature === next) return;
    signature = next;
    const selectedTitle = copy.contains(document.activeElement) ? document.activeElement.title : null;
    const heading = document.createElement('p');
    heading.className = 'sidebar__section';
    heading.textContent = 'Участники';
    const clone = rail.cloneNode(true);
    clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    const originals = rail.querySelectorAll('.member-rail__row');
    clone.querySelectorAll('.member-rail__row').forEach((button, index) => {
      button.addEventListener('click', () => { if (originals[index]?.isConnected) originals[index].click(); });
    });
    copy.replaceChildren(heading, clone);
    if (selectedTitle !== null) {
      const focused = [...clone.querySelectorAll('.member-rail__row')].find((button) => button.title === selectedTitle);
      focused?.focus({ preventScroll: true });
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(sync);
  }
  new MutationObserver((records) => {
    if (records.some((record) => !copy?.contains(record.target))) schedule();
  }).observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'src', 'title'] });
  narrow.addEventListener('change', schedule);
  sync();
})();
