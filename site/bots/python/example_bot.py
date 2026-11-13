#!/usr/bin/env python3
"""Демо-бот Майко на Python: команды, кнопки и файлы.

Запуск (Windows):
    py -m pip install -r site/bots/python/requirements.txt
    py site/bots/python/example_bot.py --token maiko_bot_...

Запуск (Linux/macOS):
    python3 -m pip install -r site/bots/python/requirements.txt
    python3 site/bots/python/example_bot.py --token maiko_bot_...

Токен создаётся командой: npm run bots:add -- --name "Python bot"
"""
from __future__ import annotations

import argparse
import os
import random
import sys
from datetime import datetime

from maiko_bot import BotContext, BotError, MaikoBot

# Windows-консоль по умолчанию не в UTF-8 — иначе русские логи выглядят мусором.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — оформление логов не должно ломать бота
        pass

HELP = """Я демо-бот Майко на Python. Команды:
/start — приветствие и кнопки
/help — этот список
/menu — меню на кнопках
/echo <текст> — повторю текст
/roll [N] — случайное число
/time — время сервера
/file — пришлю текстовый файл

В группе адресуйте команды: /help@имя_бота"""


def menu_buttons() -> list[list[dict[str, str]]]:
    return [
        [{"text": "🎲 Бросок", "data": "roll"}, {"text": "🕒 Время", "data": "time"}],
        [{"text": "📎 Файл", "data": "file"}, {"text": "ℹ️ О боте", "data": "about"}],
        [{"text": "🌐 Пример ссылки", "url": "https://example.com/"}],
    ]


def back_buttons() -> list[list[dict[str, str]]]:
    return [[{"text": "🎲 Ещё раз", "data": "roll"}, {"text": "↩️ В меню", "data": "menu"}]]


def report_file(ctx: BotContext) -> None:
    body = "\n".join(
        [
            "Файл от Python-бота Майко",
            f"Создан: {datetime.now().isoformat(timespec='seconds')}",
            f"Чат: {ctx.chat_id}",
            f"Запросил: {ctx.sender.name} ({ctx.sender.id})",
            "",
            "Тот же API, что и у JavaScript-бота: команды, кнопки, файлы.",
        ]
    )
    ctx.send_file(
        {"name": "python-bot-report.txt", "type": "text/plain", "data": body},
        caption="Готово — файл от Python-бота.",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Демо-бот Майко на Python")
    parser.add_argument("--token", default=os.environ.get("MAIKO_BOT_TOKEN"), help="токен maiko_bot_…")
    parser.add_argument("--url", default=os.environ.get("MAIKO_URL", "http://127.0.0.1:3000"))
    parser.add_argument("--avatar", default=None, help="файл картинки для аватара бота")
    args = parser.parse_args()
    if not args.token:
        raise SystemExit("Нужен токен: --token maiko_bot_... (или MAIKO_BOT_TOKEN)")

    bot = MaikoBot(token=args.token, url=args.url)

    @bot.command("start", "Приветствие и меню")
    def start(ctx: BotContext) -> None:
        ctx.reply(
            f"Привет, {ctx.sender.name or 'друг'}! Я {bot.me.get('displayName') if bot.me else 'бот'}.",
            buttons=menu_buttons(),
        )

    @bot.command("menu", "Меню на кнопках")
    def menu(ctx: BotContext) -> None:
        ctx.reply("Что показать?", buttons=menu_buttons())

    @bot.command("help", "Список команд")
    def help_command(ctx: BotContext) -> None:
        ctx.reply(HELP)

    @bot.command("echo", "Повторить текст: /echo привет")
    def echo(ctx: BotContext) -> None:
        if not ctx.command or not ctx.command.args:
            ctx.reply("Напишите так: /echo привет")
            return
        ctx.reply(ctx.command.args)

    @bot.command("roll", "Случайное число: /roll 20")
    def roll(ctx: BotContext) -> None:
        raw = ctx.command.args if ctx.command else ""
        try:
            maximum = max(2, min(int(raw), 1_000_000))
        except (TypeError, ValueError):
            maximum = 100
        ctx.reply(f"🎲 {random.randint(1, maximum)} (из {maximum})")

    @bot.command("time", "Время сервера")
    def time_command(ctx: BotContext) -> None:
        ctx.reply(f"🕒 {datetime.now().astimezone().strftime('%d.%m.%Y %H:%M:%S %Z')}")

    @bot.command("file", "Прислать текстовый файл")
    def file_command(ctx: BotContext) -> None:
        report_file(ctx)

    @bot.button()
    def on_button(ctx: BotContext) -> None:
        if ctx.data == "roll":
            ctx.edit(text=f"🎲 Выпало {random.randint(1, 100)} (из 100)", buttons=back_buttons())
        elif ctx.data == "time":
            now = datetime.now().astimezone()
            ctx.edit(
                text=f"🕒 {now.strftime('%d.%m.%Y %H:%M:%S %Z')}",
                buttons=[[{"text": "↩️ В меню", "data": "menu"}]],
            )
        elif ctx.data == "about":
            ctx.edit(
                text="Это пример бота на Python из репозитория Майко.\n"
                "Протокол тот же: токен, Socket.IO, команды, кнопки, файлы.",
                buttons=[[{"text": "↩️ В меню", "data": "menu"}]],
            )
        elif ctx.data == "file":
            report_file(ctx)
        elif ctx.data == "menu":
            ctx.edit(text="Что показать?", buttons=menu_buttons())

    @bot.on_message
    def on_message(ctx: BotContext) -> None:
        if ctx.command:
            return
        if ctx.chat_type == "dm" and ctx.text.strip():
            ctx.reply("Напишите /help или откройте /menu.")

    @bot.on_ready
    def on_ready(ready_bot: MaikoBot) -> None:
        try:
            ready_bot.set_profile(
                description="Демо-бот Майко на Python: команды, кнопки и файлы. "
                "Исходник: site/bots/python/example_bot.py.",
                avatar=args.avatar,
            )
            print("[python-bot] описание и аватар обновлены")
        except BotError as error:
            print(f"[python-bot] профиль не обновлён: {error}")
        if ready_bot.chats:
            print("[python-bot] чаты:")
            for chat in ready_bot.chats:
                kind = "ЛС" if chat.get("type") == "dm" else "группа"
                print(f"  {kind}: {chat.get('title')} ({chat.get('id')})")
        else:
            print("[python-bot] пока нет чатов — напишите боту в «Людях».")

    try:
        bot.run()
    except BotError as error:
        raise SystemExit(str(error))


if __name__ == "__main__":
    main()
