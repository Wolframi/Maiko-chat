# Майко

Realtime-мессенджер: сайт и отдельное приложение для Windows.

| Папка | Содержимое |
| --- | --- |
| `site/` | Next.js, Socket.IO, исходники сайта, ресурсы, тесты и собственные зависимости |
| `desktop/` | Electron, оболочка Windows, установщик, обновления и собственные зависимости |
| `docs/` | Общая документация |
| `scripts/` | Развёртывание сайта и миграция старых установок |

## Запуск сайта

```powershell
npm ci
npm run dev
```

Открыть http://localhost:3000. Корневые команды `dev`, `build`, `start`, `lint` выполняются в `site/`. Можно работать напрямую: `cd site; npm ci; npm run dev`.

Данные, загрузки и ключи нового сайта находятся в `site/` и исключены из Git. При обновлении старого VPS `npm ci` сохраняет существующие `data/` и `uploads/` через ссылки из `site/` и копирует локальные настройки, если их ещё нет в `site/`.

## Приложение Windows

```powershell
npm run desktop:install
npm run desktop
npm run desktop:remote
npm run desktop:build
```

Также доступны `Запустить Майко.cmd` и `Майко онлайн.cmd`. Установщик создаётся в `desktop/release/`.

Инструкции: [сайт](site/README.md), [Electron](desktop/README.md), [обновления и релизы](docs/desktop-updates.md), [сервер](docs/deployment.md), [архитектура](docs/README.md).
