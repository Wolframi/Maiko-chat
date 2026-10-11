let selected;
const api = window.maikoDesktop;
const share = document.getElementById('share');
const audio = document.getElementById('share-audio');
const audioLabel = document.getElementById('audio-label');
const audioHint = document.getElementById('audio-hint');
const captureError = document.getElementById('capture-error');
audio.disabled = true;
void api.captureSources().then(({ sources, audioAvailable }) => {
  document.getElementById('audio-option').hidden = !audioAvailable;
  for (const source of sources) {
    const button = document.createElement('button');
    button.className = 'source';
    button.setAttribute('aria-pressed', 'false');
    const image = document.createElement('img');
    image.src = source.thumbnail;
    image.alt = '';
    const name = document.createElement('span');
    name.textContent = source.id.startsWith('screen:') ? `Экран ${source.name}` : source.name;
    button.append(image, name);
    button.addEventListener('click', () => {
      selected = source.id;
      audio.disabled = !source.audioKind;
      if (!source.audioKind) audio.checked = false;
      audioLabel.textContent = source.audioKind === 'system' ? 'Передавать звук компьютера' : 'Передавать звук приложения';
      audioHint.textContent = source.audioKind === 'system'
        ? 'Звук ПК без голосов собеседников и аудио их демонстраций.'
        : source.audioKind === 'application'
          ? 'Звук приложения этого окна. Другие приложения и Майко исключены.'
          : 'Для этого окна звук недоступен. Окно Майко передаётся без звука звонка.';
      for (const item of document.querySelectorAll('.source')) item.setAttribute('aria-pressed', String(item === button));
      share.disabled = false;
    });
    document.getElementById('sources').append(button);
  }
});
const cancel = () => api.captureSelect(null);
document.getElementById('cancel').addEventListener('click', cancel);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') void cancel(); });
share.addEventListener('click', async () => {
  share.disabled = true;
  try { await api.captureSelect({ id: selected, audio: audio.checked && !audio.disabled }); }
  catch { captureError.textContent = 'Не удалось выбрать источник. Попробуйте ещё раз.'; captureError.hidden = false; share.disabled = false; }
});
