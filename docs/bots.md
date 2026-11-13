# Боты

Бот Майко — **отдельная программа на вашем компьютере** (Windows или Linux), которая
подключается к серверу по токену. Сервер ничего не запускает: вы сами пишете скрипт
на JavaScript или Python и держите его запущенным. Бот получает сообщения своих
чатов, отвечает текстом и файлами, реагирует на `/команды` и на инлайн-кнопки.

Боты добавляются **вручную** владельцем сервера — магазина ботов пока нет.

```
ваш ПК / VPS                                   сервер Майко
┌──────────────────────────┐   Socket.IO      ┌──────────────────────┐
│ echo-bot.mjs / bot.py    │◀────────────────▶│ server.ts            │
│ токен maiko_bot_…        │   auth: botToken │ data/bots.json       │
└──────────────────────────┘                  │ чаты, сообщения      │
                                              └──────────────────────┘
```

Один и тот же токен работает с любого адреса: сегодня сервер на Windows,
завтра на Linux — боту достаточно поменять `--url`/`MAIKO_URL`, код не меняется.
Бот может работать и на другом компьютере, если сервер доступен по сети.

## Как это устроено

| Часть | Где | Что делает |
|---|---|---|
| Учётная запись бота | `data/users.json` (`isBot: true`) | Бот участвует в чатах и ЛС, виден в участниках и поиске «Люди» |
| Реестр ботов | `data/bots.json` | id, логин, имя, хеш токена (SHA-256), превью токена, `lastConnectedAt` |
| Секрет управления | `data/bot-admin-secret.txt` | Локальный ключ для `npm run bots:add` и `/api/bots/admin` |
| Сокет бота | `server.ts` | `auth: { botToken }`, путь `/api/socket`; только события `bot:*` |

Открытый токен хранится только в момент создания: в `bots.json` лежит SHA-256.
Сообщения бота идут через обычный `pushMessage`: история, непрочитанные, превью,
файлы, ответы, реакции. В интерфейсе его сообщения помечены бейджем **БОТ**.

Бот **не** появляется в presence-списке «в комнате», ему не уходят push-уведомления,
он не может войти по паролю (пароль случайный и неизвестный), звонить/принимать
звонки и рассылать human-события (`message`, `group:*`, `call:*` и т.д.).

## Быстрый старт

```bash
npm run dev        # первый запуск создаёт site/data/bot-admin-secret.txt
```

В другом терминале — создать бота и получить токен:

```bash
npm run bots:add -- --name "Эхо" --username echo_bot
```

Описание и аватар можно задать сразу: `--description "Демо-бот"` и
`--avatar /uploads/….png`, а также позже из скрипта (`bot:setProfile`).

Запустить демо-бота (**на своём ПК**, сервер его не запускает):

```bash
node site/bots/echo-bot.mjs --token maiko_bot_...
```

Дальше:

- вкладка **Люди** → поиск `echo_bot` → открыть ЛС → кнопка **Старт** или `/help`;
- или сразу добавить в группу по коду (см. ниже) либо CLI:
  `npm run bots:add -- --bot echo_bot --group "Моя группа"`.

### Как добавить бота в группу по коду

1. Откройте группу → **«Пригласить»** (иконка человека с плюсом) → появится
   панель с кодом из 12 символов (например `ABCD-EFGH-JKLM`); код сразу
   копируется, а если браузер запретил буфер обмена — выделите его в панели.
   Код обновляется раз в неделю.
2. Откройте ЛС с ботом и отправьте этот код — просто сообщением или командой
   `/join ABCD-EFGH-JKLM`.
3. Бот вызывает `bot:joinGroup`; сервер проверяет код, добавляет бота в группу,
   подписывает его сокеты на комнаты и присылает `bot:added`. Бот сразу видит
   сообщения группы и может в неё писать.

Из скрипта это одна строка:

```js
const result = await bot.joinGroup("ABCD-EFGH-JKLM");
console.log(result.chat.title, result.already);
```

```python
result = bot.join_group("ABCD-EFGH-JKLM")
```

Код действует неделю и доступен только участникам группы. Альтернатива без
кода — CLI `npm run bots:add -- --bot echo_bot --group "Моя группа"` (нужен
локальный доступ к серверу и админ-секрет).

### CLI

| Команда | Действие |
|---|---|
| `npm run bots:add -- --name "Погода" [--username weather_bot] [--group "Группа"]` | Создать бота и показать токен |
| `npm run bots:add -- --bot weather_bot --group "Группа"` | Добавить существующего бота в группу |
| `npm run bots:add -- --list` | Список ботов |
| `npm run bots:add -- --rotate weather_bot` | Новый токен (старый сразу недействителен) |
| `npm run bots:add -- --remove weather_bot` | Удалить бота (история сообщений остаётся) |

Дополнительно: `--avatar /uploads/…png|jpg|gif|webp`, `--description "…"`,
`--bio`, `--owner <userId>`, `--url http://host:port` (или `MAIKO_URL`).
Секрет можно задать через `BOT_ADMIN_SECRET` вместо файла.

CLI — тонкая обёртка над локальным `POST /api/bots/admin` с заголовком
`x-bot-admin-secret`. Сервер должен быть запущен: CLI не трогает `data/*.json`
напрямую, чтобы не спорить с живым процессом.

## Команды и кнопка «Старт»

Команда — сообщение, которое начинается со `/`: `/roll 20`, `/help@echo_bot`.
Имя — `[a-zA-Z0-9_]` до 32 символов, дальше аргументы. Сервер разбирает её и
кладёт в событие `message`:

```json
{
  "id": "…", "room": "group_my-group", "author": "Алиса", "authorId": "…",
  "text": "/roll 20", "kind": "text", "createdAt": 1730000000000,
  "command": { "name": "roll", "args": "20", "target": null, "addressed": true }
}
```

`addressed` = команда адресована этому боту: явно (`/roll@echo_bot`) или неявно
в личном чате (там бот один). В группе без `@` команда придёт с
`addressed: false` — так несколько ботов в одном чате не отвечают хором.
Своё сообщение боту не возвращается — это защита от циклов ответов.

**Кнопка «Старт».** Когда пользователь открывает пустой ЛС с ботом, интерфейс
показывает кнопку **Старт**; она отправляет обычное сообщение `/start`.
Поэтому каждому боту стоит реализовать `/start` — это «витрина» бота
(приветствие + инлайн-меню). В группе кнопки нет — там команды адресуют вручную.

### Команды как ссылки

В сообщениях бота `/start`, `/help` и другие **объявленные** команды подсвечены
и кликабельны, как в Telegram. Клик отправляет команду заново: в ЛС — `/start`,
в группе — `/start@echo_bot`. Ссылки, обычный текст и незарегистрированные
`/что-то` не трогаются.

### Список команд

Бот объявляет команды прямо из скрипта:

- при вводе `/` в поле ввода появляется **выпадающий список** (как в Telegram):
  `↑`/`↓` — выбор, `Enter`/`Tab` — отправить, `Esc` — закрыть;
- в пустом ЛС с ботом — подсказка «Начните с /»;
- в данных `people`/`chatInfo` — чтобы интерфейс знал, что подсвечивать.

```js
bot.onCommand("start", handler, "Приветствие и меню");
bot.onCommand("roll", handler, "Случайное число: /roll 20");

// или явно, одним списком:
await bot.setCommands([
  { command: "start", description: "Приветствие" },
  { command: "help", description: "Справка" },
]);
```

SDK сам отправляет список на сервер после каждого `bot:ready` (в том числе после
переподключения). `setCommands([])` очищает меню.

```python
@bot.command("start", "Приветствие и меню")
def start(ctx): ...

bot.set_commands([{"command": "start", "description": "Приветствие"}])
```

Лимиты: до 32 команд, имя `[a-z0-9_]` 1–32 (регистр приводится к нижнему),
описание до 120 символов; повторы схлопываются — побеждает последнее описание.
Неверный формат → ack `{ ok: false, error }`.

### Описание и аватар

Профиль бота тоже задаётся из скрипта:

- `description` — до 512 символов, видно в шапке/инфо ЛС и в пустом чате;
- `displayName` — имя бота, можно менять;
- аватар — файл png/jpg/gif/webp, загружается как `?kind=avatar` и сразу ставится.

```js
bot.onReady(async () => {
  await bot.setProfile({
    description: "Погода в вашем городе.",
    avatar: "./avatar.png",
  });
});

// точечно:
await bot.setDescription("Погода в вашем городе.");
await bot.setAvatar("./avatar.png");
```

```python
@bot.on_ready
def ready(ready_bot):
    ready_bot.set_profile(description="Погода в вашем городе.", avatar="avatar.png")

ready_bot.set_description("…")
ready_bot.set_avatar("avatar.png")
```

Аватар принимается только от этого бота (проверяются владелец файла и magic
bytes). Имя и описание обновляются у всех участников чатов сразу: приходят
`people`/`chats` события, и интерфейс перерисовывается.

## Таблицы в сообщениях

Любое сообщение может содержать GFM-таблицу прямо в тексте:

```text
| Команда | Что делает |
|---|---|
| /start | Приветствие |
| /help | Справка |
```

Она рендерится как настоящая таблица с горизонтальной прокруткой. Если строк
больше пяти, она стартует свёрнутой; под любой таблицей есть кнопка
**«Показать строки · N» / «Свернуть таблицу»**. Ограничения: 12 колонок, 60 строк. Отдельного API не нужно —
бот просто отправляет markdown через `bot:send` / `ctx.reply`, а интерфейс
сам находит таблицы в тексте (в том числе вместе с обычными абзацами).

## Инлайн-кнопки

Бот может прикрепить к сообщению клавиатуру — до **6 рядов по 4 кнопки**.
Кнопка имеет либо `data` (callback боту), либо `url` (ссылка в браузере).

```js
await bot.sendMessage(chatId, "Что показать?", {
  buttons: [
    [{ text: "🎲 Бросок", data: "roll" }, { text: "🕒 Время", data: "time" }],
    [{ text: "🌐 Сайт", url: "https://example.com/" }],
  ],
});
```

Ограничения: подпись ≤ 64 символов, `data` ≤ 64, `url` ≤ 300 и только `http(s)`.
Нарушение → ack `{ ok: false, error: "Некорректные кнопки" }`.

Нажатие:

1. Интерфейс отправляет серверу `message:button` `{ chatId, messageId, data }`.
2. Сервер проверяет доступ, что сообщение бота и кнопка с таким `data` есть,
   и что бот в сети. Если бот офлайн — пользователь увидит ошибку.
3. Бот получает событие `bot:callback`:

```json
{
  "chatId": "dm_…", "chatType": "dm", "messageId": "…", "messageText": "Что показать?",
  "data": "roll",
  "from": { "id": "…", "name": "Алиса", "username": "alice" }
}
```

4. Бот отвечает новым сообщением (`ctx.reply`) или правит то же самое
   (`ctx.edit` / `bot:edit`) — как в Telegram. `buttons: []` убирает клавиатуру.

Кнопки хранятся вместе с сообщением, поэтому работают и после перезапуска
сервера; бот должен сам проверять `data`, если состояние устарело.
URL-кнопки сервер не пересылает боту.

## События сервер → бот

| Событие | Payload |
|---|---|
| `bot:ready` | `{ ok, bot, chats }` — профиль и список чатов (приходит после каждого подключения) |
| `message` | обычный `ChatMessage` + `command` для `/…` |
| `message:update` | изменённое/удалённое сообщение |
| `bot:callback` | нажатие инлайн-кнопки (см. выше) |
| `bot:added` | `{ chatId, type, title }` — бота добавили в чат |
| `bot:voiceState` | `{ groupId, channels: [{ id, title, users }] }` — состав голосовых каналов группы |

Сразу после `bot:ready` бот подписан на все комнаты своих чатов (включая
дополнительные текстовые каналы группы). `bot:join` переподписывает принудительно.

## События бот → сервер

| Событие | Payload | Ответ (ack) |
|---|---|---|
| `bot:send` | `{ chatId, text, replyToId?, clientId?, buttons? }` | `{ ok, messageId }` |
| `bot:sendFile` | `{ chatId, file \| files[], caption?, text?, replyToId?, buttons? }` | `{ ok, messageId, url }` |
| `bot:sendVoice` | `{ chatId, file, replyToId? }` | `{ ok, messageId, url }` |
| `bot:edit` | `{ chatId, messageId, text?, buttons? }` | `{ ok, messageId }` |
| `bot:voiceJoin` | `{ channelId }` | `{ ok, channelId, groupId, members, livekit }` |
| `bot:voiceLeave` | `{}` | `{ ok, channelId, members }` |
| `bot:voiceMembers` | `{ channelId }` | `{ ok, channelId, groupId, members }` |
| `bot:voiceMedia` | `{ muted?, deafened?, cameraOff?, sharingScreen? }` | `{ ok, muted, deafened, cameraOff, sharingScreen }` |
| `bot:setCommands` | `{ commands: [{ command, description }] }` | `{ ok, commands }` |
| `bot:setProfile` | `{ description?, displayName?, avatarUrl? }` | `{ ok, bot }` |
| `bot:typing` | `{ chatId, isTyping }` | — (индикатор «печатает») |
| `bot:chats` | `{}` | `{ ok, chats }` |
| `bot:history` | `{ chatId, before? }` | `{ ok, messages, hasMore, before }` |
| `bot:join` | `{}` | `{ ok, chats }` |
| `bot:joinGroup` | `{ code }` | `{ ok, already, chat }` |

`clientId` (`[a-zA-Z0-9_-]`, до 80 символов) делает `bot:send` идемпотентным:
повтор с тем же id не создаёт дубль.

Лимиты на бота: 60 сообщений/мин (из них 30 в один чат), 30 файлов/мин,
60 индикаторов печати/10 с, 60 запросов истории/мин, 60 правок/мин,
12 обновлений профиля (имя, описание, аватар, команды)/мин,
20 подключений/мин с IP. Текст — до 4 000 символов, подпись к файлу — до 800,
до 10 файлов в сообщении (альбом только из фото/видео).
Ошибки приходят в ack: `{ ok: false, error }`.

## Файлы

Бот загружает файл тем же `POST /api/upload` (до 500 МБ), но с токеном бота:

```bash
curl -X POST http://127.0.0.1:3000/api/upload \
  -H "x-bot-token: maiko_bot_..." \
  -F "originalName=Отчёт.txt" \
  -F "file=@Отчёт.txt"
```

```json
{ "ok": true, "file": { "url": "/uploads/…?exp=…&sig=…", "name": "Отчёт.txt", "size": 1234, "mime": "text/plain" } }
```

URL из ответа передаётся в `bot:sendFile` как есть (сервер сам проверяет
подпись, владельца и снимает query). Отправлять можно только файлы,
загруженные этим ботом, — либо GIF из Giphy, как в обычных сообщениях.
Оба SDK умеют загружать файл по пути или из памяти — см. примеры ниже.

## Голосовые сообщения

Бот отправляет голосовое сообщение через `bot:sendVoice`. Сервер требует
аудиофайл (mp3/wav/ogg/m4a/aac/flac/…), сам добавляет имя `voice-…` и текст
«Голосовое сообщение», после чего в чате появляется waveform-плеер. Если
настроен Deepgram, запускается и транскрипция, как у человеческих голосовых.

```js
await bot.sendVoice(chatId, {
  name: "voice.wav",
  type: "audio/wav",
  data: wavBuffer,
});

// ответом на сообщение:
ctx.sendVoice({ name: "voice.wav", type: "audio/wav", data: wavBuffer });
```

```python
bot.send_voice(chat_id, "voice.wav")
ctx.send_voice("voice.wav")
```

## Голосовые каналы

Бот может заходить в голосовой канал группы, видеть состав и показывать статус
(mute, камера, демонстрация). Люди видят бота в канале как обычного участника.

```js
const channels = await bot.voiceChannels(chatId);       // id + title + users
await bot.joinVoice(channels[0].id);                    // присутствие + токен
const { members } = await bot.voiceMembers(channels[0].id); // сколько и кто
await bot.voiceMedia({ muted: false, sharingScreen: true });
await bot.leaveVoice();

bot.onVoiceState((state) => {
  // state.channels[].users — кто сейчас в каналах группы
});
```

`bot:voiceJoin` возвращает `{ channelId, groupId, members, livekit }`. Если SFU
не настроен, `livekit === null` и в ответе будет `warning`: бот всё равно
виден в канале, но публиковать медиа некуда. Бот находится только в одном
канале; при обрыве сокета сервер убирает его из канала автоматически.

`voiceMedia` управляет плашками в интерфейсе (mute / камера / демонстрация) и
рассылает `voice:media` так же, как для людей.

### Аудио и видео в канале

Сервер выдаёт боту LiveKit-токен с правом публикации микрофона, камеры и
демонстрации экрана. Дальше бот подключается к SFU как обычный участник и
публикует треки — медиа идёт напрямую в LiveKit, а не через сервер Майко.

Готовый пример на Node.js — `site/bots/test-bot.mjs` (`/audio`, `/video`):
он читает медиафайлы через ffmpeg, публикует видео как `SOURCE_SCREENSHARE`,
а звук из видео — отдельным треком `SOURCE_SCREENSHARE_AUDIO`, поэтому звук
идёт вместе с демонстрацией экрана. Проверено на локальном
`livekit-server --dev`: в комнате появляются треки `screen_share` и
`screen_share_audio`, подписчик получает реальные видео- и аудиокадры.

Альтернативный пример на Python — [`site/bots/python/voice_example.py`](../site/bots/python/voice_example.py).
Он играет WAV (или сгенерированный тон), а с `--video` публикует видео как
демонстрацию; пример экспериментальный, API `livekit` rtc зависит от версии.

```bash
py -m pip install -r site/bots/python/requirements-voice.txt
py site/bots/python/voice_example.py --token maiko_bot_... \
  --channel group_my-group::voice_general --wav music.wav --video
```

## Бот на JavaScript

Нужен только `socket.io-client` (он уже в `site/node_modules`).

```js
import { createBot } from "./maiko-bot.mjs";

const bot = createBot({
  token: process.env.MAIKO_BOT_TOKEN,
  url: process.env.MAIKO_URL || "http://127.0.0.1:3000",
});

bot.onCommand("start", (ctx) =>
  ctx.reply("Привет! Я бот на JavaScript.", {
    buttons: [[{ text: "Меню", data: "menu" }]],
  }),
  "Приветствие и меню",
);

bot.onButton(async (ctx) => {
  if (ctx.data === "menu") {
    await ctx.edit({ text: "Что показать?", buttons: [[{ text: "Ещё", data: "more" }]] });
  }
  if (ctx.data === "more") {
    await ctx.edit({ text: "Готово", buttons: [] });
  }
});

bot.onMessage((ctx) => {
  if (!ctx.command && ctx.chatType === "dm") ctx.reply("Напишите /help");
});

bot.onReady(() => console.log("на связи как", bot.me.username));
```

`ctx`: `message`, `chatId`, `chatType`, `chat`, `text`, `from`, `command`,
`reply(text, opts)`, `sendFile(source, opts)`, `sendVoice(source)`,
`edit({ text, buttons })`, `typing()`, `stopTyping()`, `history(opts)`.
`source` — путь к файлу или `{ name, data, type }`; `opts` для `sendFile` —
`{ caption, buttons }`.

Ещё: `bot.sendMessage`, `bot.sendFile`, `bot.sendVoice`, `bot.editMessage`,
`bot.typing`, `bot.refreshChats`, `bot.history`, `bot.join`, `bot.joinGroup`,
`bot.ready`, `bot.me`, `bot.chats`, `bot.stop`, `bot.setCommands`,
`bot.setProfile`, `bot.setDescription`, `bot.setAvatar`, `bot.voiceChannels`,
`bot.joinVoice`, `bot.leaveVoice`, `bot.voiceMembers`, `bot.voiceMedia`,
`bot.voice`, `bot.onVoiceState`.

Готовый пример — `site/bots/echo-bot.mjs`: `/start`, `/help`, `/menu`, `/echo`,
`/roll`, `/time`, `/id`, `/file`, меню на кнопках и редактирование сообщений.

```bash
node site/bots/echo-bot.mjs --token maiko_bot_... --url http://127.0.0.1:3000
```

### Тестовый бот «всё-в-одном»

`site/bots/test-bot.mjs` — один бот, который проверяет весь API: 23 команды
с описаниями (автокомплит), инлайн-кнопки с callback и ссылкой, правку
сообщения (`bot:edit`), текстовый файл, сгенерированную PNG-картинку, аватар
и описание из скрипта, таблицы (маленькую и большую со сворачиванием),
голосовые каналы (`/voice`, `/voice_join`, `/voice_leave`), голосовое сообщение
(`/voice_msg`), музыку и видео в канале, вход в группу по коду (`/join`),
`/history`, `/whoami` и индикатор печати.

```bash
npm run bots:test -- --token maiko_bot_...
```

Медиа в голосовом канале:

| Команда | Что делает |
|---|---|
| `/audio` | Играет `site/bots/ЛИТВИНЕНКО - Оп, мусорок.mp3` как микрофонный трек |
| `/video` | Крутит `site/bots/Music BANANA! (Minions) _ Minion song.mp4` как **демонстрацию экрана**, а звук из видео публикует отдельным `screen_share_audio`-треком |
| `/media_stop` | Останавливает воспроизведение (бот остаётся в канале) |

Файлы можно заменить: `--video-file "<путь>"`, `--audio-file "<путь>"`;
канал выбирается `--channel <id|часть названия>` (по умолчанию первый).
Требуются `ffmpeg` в PATH и пакет `@livekit/rtc-node` (уже в зависимостях
`site`), а также запущенный LiveKit (`npm run livekit` — скачает и запустит
SFU, либо `livekit-server --dev`). Видео идёт **прямым потоком** ffmpeg
(`rawvideo`, 960×540, 30 fps) без нарезки на JPEG и без кэша картинок; звук —
отдельным потоком. Проверить наличие файлов и ffmpeg без подключения к каналу:

```bash
node site/bots/test-bot.mjs --check-media
```

Если файла нет или ffmpeg недоступен, бот играет встроенный тон/демо-ролик и
сообщает об этом. Полезно, чтобы глазами проверить интерфейс: начните ввод
с «/», нажмите кнопки под приветствием, вызовите `/edit`, `/image`, `/table`,
`/voice`, `/video`.

## Бот на Python

Зависимости: `python-socketio[client]` и `requests`.

Windows:

```bat
py -m pip install -r site\bots\python\requirements.txt
py site\bots\python\example_bot.py --token maiko_bot_...
```

Linux / macOS:

```bash
python3 -m pip install -r site/bots/python/requirements.txt
python3 site/bots/python/example_bot.py --token maiko_bot_...
```

Токен и адрес можно задать переменными окружения `MAIKO_BOT_TOKEN` и `MAIKO_URL`
(удобно для `.env`/systemd/PM2). Если в консоли Windows русские логи выглядят
кракозябрами, запустите `set PYTHONUTF8=1` (в PowerShell: `$env:PYTHONUTF8=1`)
или используйте `python -X utf8`.

```python
from maiko_bot import BotContext, MaikoBot

bot = MaikoBot(token="maiko_bot_...", url="http://127.0.0.1:3000")


@bot.command("start", "Приветствие и меню")
def start(ctx: BotContext) -> None:
    ctx.reply(
        "Привет! Я бот на Python.",
        buttons=[[{"text": "Меню", "data": "menu"}]],
    )


@bot.button()
def on_button(ctx: BotContext) -> None:
    if ctx.data == "menu":
        ctx.edit(text="Что показать?", buttons=[[{"text": "Ещё", "data": "more"}]])
    elif ctx.data == "more":
        ctx.edit(text="Готово", buttons=[])


@bot.on_message
def on_message(ctx: BotContext) -> None:
    if not ctx.command and ctx.chat_type == "dm":
        ctx.reply("Напишите /help")


@bot.on_ready
def ready(ready_bot: MaikoBot) -> None:
    print("на связи как", (ready_bot.me or {}).get("username"))


bot.run()
```

`ctx`: `chat_id`, `chat_type`, `text`, `sender` (`id`, `name`, `username`),
`command` (`name`, `args`, `addressed`), `data`, `message_id`, `reply`,
`send_file`, `send_voice`, `edit`, `typing`, `history`.
`send_file` принимает путь, `dict` или кортеж `(name, data, mime)`.
Профиль и команды: `bot.set_commands(...)`, `bot.set_profile(...)`,
`bot.set_description(...)`, `bot.set_avatar(...)`.
Голос: `bot.send_voice(...)`, `bot.voice_channels(...)`, `bot.join_voice(...)`,
`bot.leave_voice()`, `bot.voice_members(...)`, `bot.set_voice_media(...)`,
`bot.on_voice_state(...)`. Группы: `bot.join_group("КОД")`.

Класс `MaikoBot` сам держит сокет, переподключается и выполняет обработчики в
пуле потоков, поэтому из обработчика можно вызывать `ctx.reply`/`ctx.edit`
(ack ждётся в рабочем потоке, а не в потоке чтения сокета).
Готовый пример — `site/bots/python/example_bot.py`.

## Ограничения текущей версии

- Боты только вручную: CLI + локальный admin-API, без панели в интерфейсе.
- Бот получает события, только пока подключён. После рестарта имеет смысл
  прочитать историю (`bot:history`) и/или проверить `bot:chats`.
- Нет платежей, Web App и вебхуков (входящий HTTP-вызов бота) — бот сам решает,
  что ответить; входящие события идут по сокету.
- Бот видит только чаты, где он участник; чужие чаты недоступны даже по id.
- Удаление бота не удаляет его сообщения (они остаются как история).
- Аудио/видео в голосовом канале публикует сам процесс бота через LiveKit:
  сервер выдаёт токен и держит присутствие, но медиа-SDK и запущенный LiveKit
  нужны на стороне бота. Node.js-пример (`test-bot.mjs`) проверен; Python
  пример — экспериментальный.
- Сгенерированные таблицы в сообщениях ограничены 12 колонками и 60 строками.

## Данные и безопасность

- `data/bots.json` пишется атомарно (tmp + rename), токены — только хеши.
- `data/bot-admin-secret.txt` создаётся при первом старте сервера; в проде
  держите его вне репозитория и не публикуйте. Если сервер за прокси —
  задайте длинный `BOT_ADMIN_SECRET` (≥ 16 символов).
- Токен показывается один раз; утечка лечится `npm run bots:add -- --rotate …`
  (старые сокеты бота отключаются сразу).
- Сервер проверяет, что бот — участник чата, на каждом действии; владелец
  файла и `data` кнопки проверяются отдельно; ссылки кнопок — только `http(s)`.
- Бот не может авторизоваться как человек: логин бота в форме входа даёт
  обычное «Неверный логин или пароль».
- Секреты не храните в репозитории: передавайте токен через переменную
  окружения или аргумент командной строки.

## Тесты

```bash
cd site
npx tsx --test tests/bot-protocol.test.ts     # токены, команды, кнопки, лимиты
npx tsx --test tests/bot-commands.test.ts     # кликабельные /команды и автокомплит
npx tsx --test tests/tables.test.ts           # markdown-таблицы в сообщениях
npm run build                                 # фикстура поднимает production-сервер
npx tsx --test tests/bots.integration.ts      # создание, команда, ответ, файл, кнопки
```

Юнит-тест `bot-protocol` не требует сервера и проходит за миллисекунды.
