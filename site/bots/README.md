# Боты Майко

Бот — обычная программа на вашем компьютере. Она подключается к серверу по
токену и обменивается событиями по Socket.IO. Сервер ботов не запускает.

| Файл | Что это |
|---|---|
| `maiko-bot.mjs` | SDK на JavaScript (`socket.io-client` уже в зависимостях `site`) |
| `echo-bot.mjs` | демо-бот: `/start`, `/menu`, кнопки, файлы, описание и список команд |
| `test-bot.mjs` | тестовый бот «всё-в-одном»: команды, автокомплит, кнопки, правка, таблицы, голосовые каналы, музыка и видео со звуком в демонстрации, голосовые сообщения, файлы, картинки, аватар |
| `python/maiko_bot.py` | SDK на Python (`python-socketio`, `requests`) |
| `python/example_bot.py` | демо-бот на Python с теми же командами |
| `python/voice_example.py` | вход в голосовой канал и публикация аудио/видео через LiveKit |
| `python/requirements.txt` | зависимости Python-бота |
| `python/requirements-voice.txt` | дополнительно для аудио/видео в канале |

## Быстрый старт

```bash
# 1. сервер и токен
npm run dev
npm run bots:add -- --name "Эхо" --username echo_bot

# 2. бот на JavaScript (Windows/Linux)
node site/bots/echo-bot.mjs --token maiko_bot_...
# или полный тестовый бот
npm run bots:test -- --token maiko_bot_...

# или бот на Python
py -m pip install -r site/bots/python/requirements.txt      # Windows
python3 -m pip install -r site/bots/python/requirements.txt # Linux/macOS
python3 site/bots/python/example_bot.py --token maiko_bot_...
```

Откройте вкладку **Люди**, найдите `echo_bot`, откройте ЛС и нажмите **Старт**
(это отправит `/start`). Бота также можно добавить в группу по коду:

1. В группе нажмите **«Пригласить»** (человек с плюсом) — код появится в
   панели и скопируется; если браузер запретил буфер, выделите код вручную.
2. Отправьте код боту в ЛС (тестовый бот понимает и `/join КОД`).
3. Бот сам вступит в группу и сразу начнёт получать сообщения.

Или через CLI:

```bash
npm run bots:add -- --bot echo_bot --group "Моя группа"
```

Адрес сервера задаётся `--url` или переменной `MAIKO_URL` (по умолчанию
`http://127.0.0.1:3000`) — одинаково на Windows и Linux.

## Музыка и видео в голосовом канале

В `site/bots/` лежат медиафайлы тестового бота:

- `Music BANANA! (Minions) _ Minion song.mp4` — видео для демонстрации экрана;
- `ЛИТВИНЕНКО - Оп, мусорок.mp3` — музыка.

Нужны `ffmpeg` в PATH, пакет `@livekit/rtc-node` и запущенный LiveKit:

```bash
npm run livekit   # скачает и запустит livekit-server --dev
```

В чате с ботом:

- `/voice_join` — зайти в голосовой канал;
- `/audio` — играть mp3;
- `/video` — включить видео как демонстрацию экрана, звук из видео пойдёт
  отдельным screen-share audio треком;
- `/media_stop` — остановить, `/voice_leave` — выйти.

Проверка декодирования без LiveKit:

```bash
node site/bots/test-bot.mjs --check-media
```

Другие файлы: `--video-file "<путь>" --audio-file "<путь>"`.

Полная документация: [docs/bots.md](../../docs/bots.md) — команды, кнопки,
события, лимиты и безопасность.
