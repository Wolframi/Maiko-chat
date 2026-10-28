let selected;
let selectedSource;
const api = window.maikoDesktop;
const share = document.getElementById('share');
const audio = document.getElementById('share-audio');
const audioLabel = document.getElementById('audio-label');
const audioHint = document.getElementById('audio-hint');
const captureError = document.getElementById('capture-error');

function updateAudio() {
  audio.disabled = !selectedSource?.audioKind;
  if (audio.disabled) audio.checked = false;
  audioLabel.textContent = selectedSource?.audioKind === 'system'
    ? 'Передавать звук компьютера' : 'Передавать звук приложения';
  audioHint.textContent = selectedSource?.audioKind === 'system'
      ? 'Звук ПК подключается автоматически. Голоса и демонстрации собеседников исключены.'
      : selectedSource?.audioKind === 'application'
        ? 'Только звук приложения этого окна. Мост DAW подключится автоматически; другие приложения исключены.'
        : 'Для этого окна звук недоступен. Окно Майко передаётся без звука звонка.';
}
const dawStatus = document.getElementById('daw-status');
const dawButton = document.getElementById('download-daw');
function showDawInstalled(installed) {
  dawButton.textContent = installed ? '✓ Установлено' : 'Скачать VST3';
  dawButton.disabled = installed;
  dawButton.classList.toggle('is-installed', installed);
}
dawButton.addEventListener('click', async () => {
  dawButton.disabled = true;
  dawButton.textContent = 'Установка…';
  dawStatus.hidden = true;
  try {
    const result = await api.installDawBridge();
    if (!result?.installed) throw new Error('VST3 не установлен');
    showDawInstalled(true);
    dawStatus.textContent = 'В FL Studio откройте Options → Manage plugins → Find installed plugins. Добавьте Maiko DAW Bridge на Master.';
    dawStatus.hidden = false;
  } catch {
    showDawInstalled(false);
    dawStatus.textContent = 'Не удалось установить VST3. Закройте DAW и повторите. Разрешите установку в системную папку VST3 в запросе Windows.';
    dawStatus.hidden = false;
  }
});
audio.disabled = true;
void api.captureSources().then(({ sources, audioAvailable, dawInstalled }) => {
  showDawInstalled(dawInstalled === true);
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
      selectedSource = source;
      updateAudio();
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
