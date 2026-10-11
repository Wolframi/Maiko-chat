# MCP для Майко

Серверы настроены для этого проекта в `.codex/config.toml`.
Пакеты установлены отдельно в `.codex/mcp/node_modules`; зависимости самого чата не меняются.

| Сервер | Версия пакета | Назначение |
| --- | --- | --- |
| [Next DevTools (Vercel)](https://github.com/vercel/next-devtools-mcp) | 0.4.0 | Диагностика Next.js 16, маршруты, ошибки, документация |
| [Playwright (Microsoft)](https://github.com/microsoft/playwright-mcp) | 0.0.81 | Проверка страниц, адаптивности, консоли и сетевых запросов |
| [Context7 (Upstash)](https://github.com/upstash/context7) | 4.1.1 | Поиск документации и примеров для библиотек |
| [Token Savior](https://github.com/Mibayy/token-savior) | 4.21.0 | Структурная навигация по коду и постоянная память с экономным MCP-профилем |
| [Blenderwright](https://github.com/HoldMyBeer-gg/blenderwright) | 2.0.1 | Управление Blender 5.2 через MCP: модель, материалы, риг, анимация, рендер |

## Запуск

Откройте новую сессию Codex в `D:\Chat` после установки, чтобы загрузить MCP-инструменты.
В уже открытой сессии новый набор инструментов может не появиться до перезапуска приложения.
Проверка того, что Codex прочитал конфигурацию: `codex mcp list`.
Проектная конфигурация применяется к доверенным проектам.

Next DevTools использует запущенный сервер разработки (`npm run dev`).
Playwright настроен на установленный Microsoft Edge, без видимого окна, с отдельным временным профилем.
Context7 обращается к внешнему сервису документации; без API-ключа действуют анонимные лимиты.
В поисковые запросы документации не следует включать секреты и пользовательские сообщения.

## Восстановление и проверка

```powershell
npm ci --prefix .codex/mcp
uv venv --python 3.12 .codex/mcp/token-savior-venv
uv pip install --python .codex/mcp/token-savior-venv/Scripts/python.exe -r .codex/mcp/requirements-token-savior.txt
uv venv --python 3.12 .codex/mcp/blenderwright-venv
uv pip install --python .codex/mcp/blenderwright-venv/Scripts/python.exe -r .codex/mcp/requirements-blenderwright.txt
node .codex/mcp/check.mjs
node .codex/mcp/check.mjs --docs-query
```

Проверка запускает каждый сервер, выполняет MCP initialize и tools/list, затем завершает процессы.
Флаг `--docs-query` дополнительно выполняет публичный запрос документации React через Context7.
Проверка Playwright подтверждает доступность MCP-инструментов, но не запускает браузер.
Token Savior ограничен каталогом `D:\Chat`, идентифицирует клиент как `codex` и использует профиль `optimized`.

Blenderwright также требует расширение в Blender. Для установленного через Steam Blender 5.2.2 расширение v2.0.1 находится в профиле `%APPDATA%\Blender Foundation\Blender\5.2\extensions\user_default\blenderwright`; архив релиза сохранён в `.codex/mcp/vendor/blenderwright-v2.0.1.zip`. Для повторной установки откройте Blender: **Edit → Preferences → Get Extensions → ▾ → Install from Disk...**, выберите этот архив и включите расширение. После установки или обновления полностью перезапустите Blender, откройте панель `N` в 3D Viewport, вкладку `blenderwright`, и нажмите **Start Server** (порт 9876). Сервер MCP подключится к нему по `127.0.0.1`. Команда `node .codex/mcp/check.mjs` проверяет MCP без запущенного Blender; для работы инструментов нужен запущенный сервер расширения.

Версии закреплены в package.json, package-lock.json и requirements-token-savior.txt. Обновляйте их осознанно.
При переносе проекта в другой каталог поправьте абсолютные пути и `cwd` в `.codex/config.toml`.
Для отключения сервера добавьте `enabled = false` в его секцию.

Документация проектной конфигурации: https://developers.openai.com/codex/mcp
