# Майко

Realtime-мессенджер: чаты как в Telegram, группы и звонки как в Discord.

Приложение для Windows (Electron): двойной щелчок по `Запустить Майко.cmd` для локального сайта или `Майко онлайн.cmd` для подключения к онлайн-серверу. Сборка установщика: `npm run desktop:build`. Инструкции: [desktop/README.md](../desktop/README.md).

Документация (архитектура, ЛС, гильдии, голос, шумодав):

- [docs/README.md](../docs/README.md) — оглавление
- [Чаты как Telegram](../docs/chats.md)
- [Группы как Discord](../docs/groups.md)
- [Голос и звонки](../docs/voice.md)

## Run locally

```bash
npm install
npm run livekit   # свой SFU на ВМ: ws://127.0.0.1:7880 (не LiveKit Cloud)
npm run dev
```

Open http://localhost:3000

Групповые голосовые каналы идут через этот LiveKit. Личные звонки — P2P, SFU им не нужен.

Расшифровка голосовых сообщений использует Deepgram Nova-3. Задайте серверный
`DEEPGRAM_API_KEY` или сохраните ключ в `.deepgram-api-key`. По умолчанию включён
мультиязычный режим (`DEEPGRAM_LANGUAGE=multi`); специализированные имена можно
передать через `DEEPGRAM_KEYTERMS`, разделяя их запятыми или переводами строк.

## Demo accounts

Created automatically unless `SEED_DEMO=0`:

| Login | Password |
|-------|----------|
| artem | Artem1234! |
| alice | Alice1234! |
| bob | Bob12345! |
| kirill | Kirill123! |

## Bots

Боты добавляются вручную и работают отдельным процессом с токеном — на вашем
ПК, не на сервере. Умеют отправлять сообщения и файлы, отвечать на `/команды`,
показывать инлайн-кнопки, объявлять список команд, описание и аватар; `/команды`
в сообщениях бота кликабельны; в пустом ЛС есть кнопка **Старт**.

```bash
npm run dev                                   # создаст data/bot-admin-secret.txt
npm run bots:add -- --name "Эхо" --username echo_bot
node bots/echo-bot.mjs --token maiko_bot_...  # пример на JavaScript
python3 bots/python/example_bot.py --token maiko_bot_...   # пример на Python
```

Примеры: [bots/README.md](bots/README.md). Полная инструкция и API:
[docs/bots.md](../docs/bots.md).

## Production

```bash
npm run build
SEED_DEMO=1 NEXT_PUBLIC_DEMO=1 npm start
```

VPS (PM2 + nginx): `powershell -File ../scripts/deploy.ps1`

Health check: `GET /api/health`

Хранение сообщений в MongoDB и перенос истории: [docs/mongodb.md](../docs/mongodb.md).
