# Pulse — документация

**Pulse** — realtime-мессенджер: личные чаты в духе Telegram и группы со звонками в духе Discord.

| Что видит пользователь | Откуда идея | Как устроено в Pulse |
|---|---|---|
| ЛС, ответы, альбомы, голосовые, галочки прочтения | Telegram | `useChat` + пузыри сообщений |
| Левая колонка серверов, `#general`, голосовые каналы, список участников | Discord | `ServerRail` + guild-сайдбар + `GuildMemberList` |
| Сцена звонка, dock внизу, mute / deafen / камера / экран | Discord | `VoiceOverlay`, `CallOverlay`, `VoiceDock` |
| Шумодав, эхоподавление | Discord (Krisp / RNNoise) | `src/lib/noiseFilter.ts` + браузерный AEC |

## Оглавление

1. [Обзор продукта](./overview.md) — что это, для кого, карта экранов
2. [Архитектура](./architecture.md) — стек, файлы, данные, события
3. [Чаты как Telegram](./chats.md) — ЛС, сообщения, медиа, 1:1 звонки
4. [Группы как Discord](./groups.md) — серверы, каналы, роли владельца, инвайты
5. [Голос и звонки](./voice.md) — сцена Discord, P2P в ЛС / SFU в группах, шумоподавление
6. [UI звонков Discord](./discord-call-ui.md) — тайлы, speaking-кольцо, «Calling…» до ответа, входящий, карта на Pulse

Краткий запуск — в корневом [README.md](../README.md).
