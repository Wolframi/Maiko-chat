# Pulse Chat

Realtime-мессенджер: чаты как в Telegram, группы и звонки как в Discord.

Документация (архитектура, ЛС, гильдии, голос, шумодав):

- [docs/README.md](docs/README.md) — оглавление
- [Чаты как Telegram](docs/chats.md)
- [Группы как Discord](docs/groups.md)
- [Голос и звонки](docs/voice.md)

## Run locally

```bash
npm install
npm run livekit   # свой SFU на ВМ: ws://127.0.0.1:7880 (не LiveKit Cloud)
npm run dev
```

Open http://localhost:3000

Групповые голосовые каналы идут через этот LiveKit. Личные звонки — P2P, SFU им не нужен.

## Demo accounts

Created automatically unless `SEED_DEMO=0`:

| Login | Password |
|-------|----------|
| artem | Artem1234! |
| alice | Alice1234! |
| bob | Bob12345! |
| kirill | Kirill123! |

## Production

```bash
npm run build
SEED_DEMO=1 NEXT_PUBLIC_DEMO=1 npm start
```

VPS (PM2 + nginx): `powershell -File scripts/deploy.ps1`

Docker:

```bash
docker build -t pulse-chat .
docker run -p 3000:3000 -e PUBLIC_ORIGIN=https://your.domain pulse-chat
```

Health check: `GET /api/health`
