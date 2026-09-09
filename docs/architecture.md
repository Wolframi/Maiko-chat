# Архитектура

## Стек

| Слой | Технология |
|---|---|
| UI | Next.js 16, React 19, Motion, Tailwind 4 |
| Realtime | Socket.IO (кастомный `server.ts`, не serverless) |
| Голос ЛС | WebRTC P2P (`useCall`) |
| Голос группы | свой LiveKit SFU на ВМ (`useVoiceChannel`) |
| ICE | STUN Google/Cloudflare + TURN (свой или Open Relay) |
| Хранение | JSON в `data/` (чаты, сообщения, юзеры, сессии) |
| Медиа | загрузки на диск `uploads/`, транскод видео |
| PWA | `public/manifest.webmanifest`, `public/sw.js`, Web Push |

Точка входа сервера — `server.ts`: HTTP (Next + API) и Socket.IO на одном порту.

## Карта кода

```
server.ts                      кастомный HTTP + Socket.IO + LiveKit token
src/server/auth.ts             аккаунты, scrypt, сессии 30 дней
src/server/chats.ts            ЛС, группы, голосовые каналы
src/server/uploads.ts          файлы
src/hooks/useChat.ts           клиент чата
src/hooks/useCall.ts           1:1 звонок (P2P)
src/hooks/useVoiceChannel.ts   групповой канал → LiveKit SFU
src/hooks/useVoiceChannelLiveKit.ts
src/lib/webrtcMedia.ts         камера / экран / contentHint
src/lib/iceServers.ts          STUN/TURN
src/components/chat/ChatApp.tsx     шелл workspace
src/components/chat/ServerRail.tsx
src/components/chat/ChatSidebar.tsx
src/components/chat/GuildMemberList.tsx
src/components/chat/VoiceOverlay.tsx
src/components/chat/CallOverlay.tsx
src/components/chat/VoiceDock.tsx
```

## Данные на диске

| Файл | Содержимое |
|---|---|
| `data/chats.json` | мета чатов и голосовых каналов |
| `data/messages.json` | история |
| `data/users.json` | аккаунты |
| `data/sessions.json` | токены |
| `data/pins.json` / `reads.json` | пины и last-read |

Запись атомарная: tmp-файл + rename. Presence голоса **не** персистится — это in-memory карты в `server.ts`.

## Модель чата

```ts
type ChatType = "channel" | "dm" | "group";
```

`channel` — наследие; при `loadChats()` такие записи пропускаются. Живые типы: `dm` и `group`.

Группа хранит `voiceChannels[]`. Id канала: `{groupId}::voice_general` или `{groupId}::voice_{slug}_{rand}`.

## Авторизация

- Регистрация / логин по логину и паролю (`scrypt`).
- Токен в `localStorage`, заголовок `x-pulse-token` и Socket.IO auth.
- Сессия 30 дней.

## HTTP API (помимо Next)

| Путь | Назначение |
|---|---|
| `GET /api/health` | процесс жив |
| `GET /api/health/livekit` | SFU отвечает |
| `POST /api/livekit/token` | JWT участника (только если уже в голосовом канале) |
| `GET /api/ice` | список ICE для браузера |

Токен LiveKit выдаётся только тому, кто уже прошёл `voice:join` в этот канал. Rate limit: 30 запросов / минуту.

## Socket.IO — основные события

### Чаты

`message`, `message:edit`, `message:delete`, `message:react`, `message:pin`, `message:forward`, `message:file`, `typing`, `chats:read`

### Группы

`group:create`, `group:join`, `group:leave`, `group:delete`, `group:invite`, `group:invite:respond`, `group:visibility`, `group:avatar`, `group:update`

### Личные звонки

`call:invite` → `call:incoming` → `call:signal` (SDP/ICE) → `call:dismiss` / `call:log`

### Голосовые каналы

`voice:create` / `voice:delete`  
`voice:join` / `voice:leave` / `voice:kick`  
`voice:state` (presence всей группы)  
`voice:mute` / `voice:deafen` / `voice:speaking` / `voice:media`  
`voice:signal` — групповой mesh больше не используется (каналы всегда SFU)

## Presence голоса на сервере

```
voiceByChannel  channelId → (userId → VoiceMember)
voiceByUser     userId → channelId     (один канал на человека)
voiceBySocket   socketId → channelId   (мульти-вкладки)
```

Grace на дисконнект: **12 с**. Если сокет вернулся — presence сохраняется. Иначе участника снимают. Вторая вкладка того же пользователя получает `voice:kick` с `reason: "takeover"`.

## Деплой

Прод: VPS, PM2 `pulse-chat`, nginx → `:3000`. Свой LiveKit на той же ВМ (`scripts/setup-livekit-vps.sh`, не Cloud): порты 7880/7881, UDP 50000–50100, WS через `wss://<хост>/livekit`. Локально: `npm run livekit`.
