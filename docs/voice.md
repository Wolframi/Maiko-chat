# Голос и звонки как Discord

Два клиента, одна визуальная система.

| | Групповой канал | Личный звонок |
|---|---|---|
| Хук | `useVoiceChannel` | `useCall` |
| UI | `VoiceOverlay` + `VoiceDock` | `CallOverlay` |
| Транспорт | свой LiveKit SFU на ВМ | P2P (`RTCPeerConnection`) |
| Signalling | `voice:*` | `call:*` |

Оба оверлея ставят сцену `call__stage--discord`.

## Стиль сцены (Discord)

CSS: `src/app/globals.css` → `.call__stage--discord`.

```
┌─────────────────────────────────────────┬──────────┐
│  call__main-area                        │ rail     │
│  пусто: «участники справа»              │ камеры / │
│  или демонстрация экрана (1 или 2)      │ аватары  │
│  фон #0a0a0c                            │ 232px    │
└─────────────────────────────────────────┴──────────┘
           call__bar: mute · deafen · NS · cam · screen · leave
```

- Фон сцены `#111214`, как Discord dark.
- Сетка: `minmax(0,1fr) 232px`.
- Без шаринга — слева плейсхолдер с названием канала, люди только в рейле.
- С шарингом — экран(ы) в `call__screens`; два экрана — две колонки.
- Тайл: видео или аватар. Класс `is-speaking` — зелёное кольцо.
- Камера помечена `contentHint: "motion"`, экран `"detail"` — чтобы отличить треки в одном `MediaStream`.
- Свёрнутый канал: не прячется, а становится **Voice dock** внизу сайдбара (mute / deafen / leave / развернуть) — как нижняя панель Discord.

Личный звонок использует ту же сцену плюс индикаторы сети (RTT good/ok/poor) и ринг.

Подробный разбор того, **как Discord рисует участников и момент «Calling…» до accept** (и как это сопоставлено с Pulse): [discord-call-ui.md](./discord-call-ui.md).

## Управление как в Discord

| Кнопка | Действие |
|---|---|
| Микрофон | `track.enabled = false`, событие `voice:mute`; unmute снимает deafen |
| Наушники (deafen) | глушит входящие `<audio>` и мутит себя; undeafen снова включает микрофон |
| Шумоподавление | кнопка-звезда: Krisp → RNNoise → браузерный NS |
| Камера | отдельный `getUserMedia({ video })`; в ЛС можно вместе с экраном |
| Экран | `getDisplayMedia`, bitrate до 2.8 Mbps / 24 fps |
| Повесить | `voice:leave` / конец call |

Deafen на сервере форсирует `muted: true` и `speaking: false`, чтобы в списке канала сразу был перечёркнутый микрофон.

Камера в канале стартует выключенной (как Discord). В 1:1 — тоже mic-first: видео по кнопке.

## Топология: P2P в ЛС, SFU в группах

Сервер — источник истины (`server.ts`): голосовой канал группы **всегда** `sfu`. Личные звонки в эту карту не попадают.

```
Личный звонок (ЛС)     →  P2P WebRTC (`useCall`)
Голосовой канал группы →  свой LiveKit SFU на этой ВМ (`useVoiceChannel` → LiveKit)
```

LiveKit Cloud не используется: URL `*.livekit.cloud` сервер отбрасывает. Локально без `.livekit-*` файлов Pulse берёт `ws://127.0.0.1:7880` и ключи `devkey` / `secret` (`livekit-server --dev`).

```bash
npm run livekit   # docker compose -f docker-compose.livekit.yml up
npm run dev
```

На прод-ВМ: `bash scripts/setup-livekit-vps.sh` (LiveKit на `127.0.0.1:7880`, снаружи `wss://<хост>/livekit` через nginx).

Если SFU не поднялся, клиент **выходит из канала** с ошибкой, а не остаётся «в канале без звука».

## P2P (только личные звонки)

`useCall.ts`:

- На пира — свой `RTCPeerConnection`.
- Offer/answer/ICE через `call:signal`.
- ICE: `/api/ice` → STUN + TURN (`src/lib/iceServers.ts`).
- Видео: `replaceTrack` / `attachLocalVideoTrackByHint`, камера и экран вместе.
- Камера ~720p / 1.5 Mbps, экран ~1080p / 2.8 Mbps.

`voice:signal` для группового канала сервер не пропускает (топология всегда `sfu`).

## LiveKit (SFU, только группы)

1. Клиент уже в `voice:join`.
2. `POST /api/livekit/token` `{ channelId }` → JWT на 1 час, `identity = userId`.
3. `Room.connect(serverUrl, token)`, публикация mic / camera / screenshare.
4. Комната на SFU: `liveKitRoomName(channelId)`, max 12 участников, empty timeout 300 с.

Секреты: `.livekit-url`, `.livekit-api-key`, `.livekit-api-secret` (или env). Health: `GET /api/health/livekit`.

## Шумоподавление

Слой [`src/lib/noiseFilter.ts`](../src/lib/noiseFilter.ts) вешается на **исходящий** микрофон до публикации.

Порядок:

1. **Krisp** — `@livekit/krisp-noise-filter`, WASM на клиенте (не Cloud). Если браузер/пакет не поднимает процессор — дальше RNNoise.
2. **RNNoise** — `@shiguredo/rnnoise-wasm` через `ScriptProcessor` / тот же processor на LiveKit-треке.
3. **Браузерный NS** — `noiseSuppression: true` в `getUserMedia`, если WASM не загрузился.

Эхо и громкость всегда на браузере: `echoCancellation` + `autoGainControl`. Когда нейро-фильтр включён, браузерный `noiseSuppression` выключается, чтобы два шумодава не портили голос.

Тоггл на панели звонка (звезда), предпочтение в `localStorage` (`pulse-noise-suppression`, по умолчанию вкл). Если модель не поднялась, звонок не падает — тост и откат на браузерный NS.

Где подключено: `useCall` (P2P), `useVoiceChannelLiveKit` (группы), `VoiceRecorderBar`.

## Индикатор «говорит»

**1:1:** `AnalyserNode`, FFT 256, средний уровень по бинам. Порог **> 18**, удержание **320 мс**. Свой тайл тоже подсвечивается.

**SFU:** `RoomEvent.ActiveSpeakersChanged` от LiveKit, плюс `voice:speaking` на сервер.

Сервер кладёт флаг в `VoiceMember` и рассылает `voice:state`. UI: кольцо на аватаре в оверлее и в списке канала.

## ICE / NAT

`src/lib/iceServers.ts`:

1. Google STUN, STUN хоста, TURN UDP/TCP/TLS если заданы `TURN_USER` / `TURN_PASS`.
2. Иначе публичный Open Relay (запасной).
3. Cloudflare STUN.

Клиент кэширует ответ `/api/ice`. Без TURN звонки через симметричный NAT часто не соберутся — на проде TURN обязателен (тот же, что прописывается в LiveKit yaml).

## Конфликты и устойчивость

- Один пользователь = один голосовой канал **или** один 1:1 звонок.
- Новая вкладка выгоняет старую (`voice:kick` / takeover).
- Обрыв сокета: 12 с на reconnect, затем leave.
- После `connect` клиент сам делает `voice:join` повторно.

## Медиа-хелперы

`src/lib/webrtcMedia.ts` — общие constraints и разбор «это камера или экран»: `displaySurface`, `facingMode`, `contentHint`, label. Нужно, потому что в одном `MediaStream` живут mic + cam + screen, а сцена Discord показывает их в разных слотах.
