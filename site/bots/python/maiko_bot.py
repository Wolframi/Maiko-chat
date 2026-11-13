"""Небольшой SDK для ботов Майко на Python.

Зависимости: python-socketio[client], requests (см. requirements.txt).
Бот работает на вашем компьютере (Windows или Linux) и подключается к серверу
по токену — сервер ничего не запускает сам.

    from maiko_bot import MaikoBot

    bot = MaikoBot(token="maiko_bot_...", url="http://127.0.0.1:3000")

    @bot.command("start")
    def start(ctx):
        ctx.reply("Привет! Я на Python.", buttons=[[{"text": "Меню", "data": "menu"}]])

    @bot.button()
    def any_button(ctx):
        ctx.edit(text=f"Нажато: {ctx.data}")

    bot.run()
"""

from __future__ import annotations

import mimetypes
import pathlib
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional

import requests
import socketio
from socketio.exceptions import TimeoutError as SocketTimeoutError

DEFAULT_URL = "http://127.0.0.1:3000"
MAX_TEXT = 4000


class BotError(RuntimeError):
    """Сервер отклонил запрос бота."""


@dataclass
class BotCommand:
    name: str
    args: str = ""
    target: Optional[str] = None
    addressed: bool = False


@dataclass
class BotSender:
    id: Optional[str] = None
    name: Optional[str] = None
    username: Optional[str] = None


class BotContext:
    """Контекст одного события: команды, сообщения или нажатия кнопки."""

    def __init__(
        self,
        bot: "MaikoBot",
        *,
        chat_id: str,
        chat_type: Optional[str] = None,
        message: Optional[dict[str, Any]] = None,
        command: Optional[BotCommand] = None,
        button_data: Optional[str] = None,
        message_id: Optional[str] = None,
        sender: Optional[BotSender] = None,
        text: str = "",
    ) -> None:
        self._bot = bot
        self.chat_id = chat_id
        self.chat_type = chat_type or ("dm" if str(chat_id).startswith("dm_") else "group")
        self.message = message or {}
        self.command = command
        self.data = button_data
        self.message_id = message_id or (message or {}).get("id")
        self.sender = sender or BotSender()
        self.text = text

    # --- действия бота -------------------------------------------------
    def reply(
        self,
        text: str,
        *,
        buttons: Optional[list[list[dict[str, str]]]] = None,
        reply_to: Optional[str] = None,
        client_id: Optional[str] = None,
    ) -> Optional[str]:
        return self._bot.send_message(
            self.chat_id,
            text,
            buttons=buttons,
            reply_to=reply_to or self.message_id,
            client_id=client_id,
        )

    def send_file(
        self,
        source: Any,
        *,
        caption: Optional[str] = None,
        buttons: Optional[list[list[dict[str, str]]]] = None,
    ) -> Optional[str]:
        return self._bot.send_file(
            self.chat_id,
            source,
            caption=caption,
            reply_to=self.message_id,
            buttons=buttons,
        )

    def send_voice(self, source: Any, *, reply_to: Optional[str] = None) -> Optional[str]:
        return self._bot.send_voice(
            self.chat_id,
            source,
            reply_to=reply_to or self.message_id,
        )

    def edit(
        self,
        *,
        text: Optional[str] = None,
        buttons: Optional[list[list[dict[str, str]]]] = None,
    ) -> Optional[str]:
        if not self.message_id:
            raise BotError("Нечего редактировать: нет message_id")
        return self._bot.edit_message(self.chat_id, self.message_id, text=text, buttons=buttons)

    def typing(self) -> None:
        self._bot.typing(self.chat_id, True)

    def stop_typing(self) -> None:
        self._bot.typing(self.chat_id, False)

    def history(self, before: Optional[str] = None) -> dict[str, Any]:
        return self._bot.history(self.chat_id, before=before)


class MaikoBot:
    """Клиент бота: подключение по токену, команды, кнопки, файлы."""

    def __init__(
        self,
        token: str,
        url: str = DEFAULT_URL,
        *,
        logger: Callable[[str], None] = print,
        workers: int = 4,
    ) -> None:
        if not token:
            raise BotError("Нужен токен бота: npm run bots:add -- --name \"Мой бот\"")
        self.token = token
        self.url = str(url).rstrip("/")
        self.me: Optional[dict[str, Any]] = None
        self.chats: list[dict[str, Any]] = []
        self.voice: Optional[dict[str, Any]] = None
        self._logger = logger
        self._ready = threading.Event()
        self._pool = ThreadPoolExecutor(max_workers=max(1, workers))
        self._command_handlers: dict[str, list[Callable[[BotContext], Any]]] = {}
        self._command_descriptions: dict[str, str] = {}
        self._commands_synced = threading.Event()
        self._message_handlers: list[Callable[[BotContext], Any]] = []
        self._button_handlers: list[Callable[[BotContext], Any]] = []
        self._voice_state_handlers: list[Callable[[dict[str, Any]], Any]] = []
        self._ready_handlers: list[Callable[["MaikoBot"], Any]] = []
        self._sio = socketio.Client(reconnection=True, reconnection_delay=1, reconnection_delay_max=10)
        self._register_events()

    # --- регистрация обработчиков --------------------------------------
    def command(
        self,
        name: str,
        description: str = "",
    ) -> Callable[[Callable[[BotContext], Any]], Callable[[BotContext], Any]]:
        """Декоратор: @bot.command("start", "Приветствие"). Имя без слэша; "*" — все."""
        key = str(name).lstrip("/").lower()

        def decorator(handler: Callable[[BotContext], Any]) -> Callable[[BotContext], Any]:
            self._command_handlers.setdefault(key, []).append(handler)
            if key != "*":
                text = str(description or "").strip()[:120]
                if text or key not in self._command_descriptions:
                    self._command_descriptions[key] = text
            return handler

        return decorator

    def on_message(self, handler: Callable[[BotContext], Any]) -> Callable[[BotContext], Any]:
        self._message_handlers.append(handler)
        return handler

    def button(self) -> Callable[[Callable[[BotContext], Any]], Callable[[BotContext], Any]]:
        """Декоратор: @bot.button() — любое нажатие инлайн-кнопки."""

        def decorator(handler: Callable[[BotContext], Any]) -> Callable[[BotContext], Any]:
            self._button_handlers.append(handler)
            return handler

        return decorator

    def on_ready(self, handler: Callable[["MaikoBot"], Any]) -> Callable[["MaikoBot"], Any]:
        self._ready_handlers.append(handler)
        return handler

    def on_voice_state(
        self,
        handler: Callable[[dict[str, Any]], Any],
    ) -> Callable[[dict[str, Any]], Any]:
        """Изменения состава голосовых каналов группы (bot:voiceState)."""
        self._voice_state_handlers.append(handler)
        return handler

    # --- транспорт ------------------------------------------------------
    def connect(self, timeout: float = 20) -> "MaikoBot":
        self._ready.clear()
        self._commands_synced.clear()
        self._sio.connect(
            self.url,
            auth={"botToken": self.token},
            socketio_path="api/socket",
            transports=["websocket"],
            wait_timeout=timeout,
        )
        if not self._ready.wait(timeout):
            raise BotError("Сервер не прислал bot:ready")
        if self._command_descriptions:
            self._commands_synced.wait(5)
        return self

    def run(self) -> None:
        try:
            self.connect()
            self._sio.wait()
        except KeyboardInterrupt:
            self._logger("[bot] остановлен")
        finally:
            self.stop()

    def join_group(self, code: str) -> dict[str, Any]:
        """Войти в группу по коду приглашения (как group:join-code)."""
        result = self._call("bot:joinGroup", {"code": str(code or "")}, 20)
        try:
            self.fetch_chats()
        except BotError:
            pass
        return result

    def stop(self) -> None:
        try:
            self._sio.disconnect()
        except Exception:  # noqa: BLE001 — остановка не должна падать
            pass
        self._pool.shutdown(wait=False)

    # --- методы API ------------------------------------------------------
    def send_message(
        self,
        chat_id: str,
        text: str,
        *,
        buttons: Optional[list[list[dict[str, str]]]] = None,
        reply_to: Optional[str] = None,
        client_id: Optional[str] = None,
        timeout: float = 15,
    ) -> Optional[str]:
        payload: dict[str, Any] = {"chatId": chat_id, "text": str(text)[:MAX_TEXT]}
        if reply_to:
            payload["replyToId"] = reply_to
        if buttons is not None:
            payload["buttons"] = buttons
        if client_id:
            payload["clientId"] = client_id
        result = self._call("bot:send", payload, timeout)
        return result.get("messageId")

    def edit_message(
        self,
        chat_id: str,
        message_id: str,
        *,
        text: Optional[str] = None,
        buttons: Optional[list[list[dict[str, str]]]] = None,
        timeout: float = 15,
    ) -> Optional[str]:
        payload: dict[str, Any] = {"chatId": chat_id, "messageId": message_id}
        if text is not None:
            payload["text"] = str(text)[:MAX_TEXT]
        if buttons is not None:
            payload["buttons"] = buttons
        result = self._call("bot:edit", payload, timeout)
        return result.get("messageId")

    def set_commands(self, commands: Iterable[Any]) -> list[dict[str, str]]:
        """Список команд для меню: строки или {"command","description"}."""
        normalized: list[dict[str, str]] = []
        for item in commands or []:
            if isinstance(item, str):
                name, description = item, ""
            elif isinstance(item, dict):
                name = str(item.get("command") or "")
                description = str(item.get("description") or "")
            else:
                continue
            name = name.lstrip("/").strip().lower()
            if not name:
                continue
            normalized.append({"command": name, "description": description[:120]})
        self._command_descriptions = {
            item["command"]: item["description"] for item in normalized
        }
        result = self._call("bot:setCommands", {"commands": normalized}, 15)
        self._commands_synced.set()
        return result.get("commands") or normalized

    def set_profile(
        self,
        *,
        description: Optional[str] = None,
        display_name: Optional[str] = None,
        avatar: Any = None,
    ) -> Optional[dict[str, Any]]:
        """Описание, имя и аватар бота (аватар загружается файлом)."""
        payload: dict[str, Any] = {}
        if description is not None:
            payload["description"] = str(description)[:512]
        if display_name is not None:
            payload["displayName"] = str(display_name)
        if avatar is not None:
            payload["avatarUrl"] = self.upload(avatar, avatar=True)["url"]
        result = self._call("bot:setProfile", payload, 30)
        if result.get("bot"):
            self.me = result["bot"]
        return result.get("bot")

    def set_description(self, text: str) -> Optional[dict[str, Any]]:
        return self.set_profile(description=text)

    def set_avatar(self, source: Any) -> Optional[dict[str, Any]]:
        return self.set_profile(avatar=source)

    def upload(self, source: Any, *, avatar: bool = False) -> dict[str, Any]:
        name, data, mime = _file_payload(source)
        response = requests.post(
            f"{self.url}/api/upload{'?kind=avatar' if avatar else ''}",
            headers={"x-bot-token": self.token},
            data={"originalName": name},
            files={"file": (name, data, mime)},
            timeout=120,
        )
        try:
            payload = response.json()
        except ValueError as error:
            raise BotError(f"Загрузка не удалась ({response.status_code})") from error
        if not payload.get("ok"):
            raise BotError(str(payload.get("error") or "Загрузка не удалась"))
        return payload["file"]

    def send_file(
        self,
        chat_id: str,
        source: Any,
        *,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        buttons: Optional[list[list[dict[str, str]]]] = None,
        timeout: float = 30,
    ) -> Optional[str]:
        uploaded = self.upload(source)
        payload: dict[str, Any] = {
            "chatId": chat_id,
            "file": {
                "url": uploaded["url"],
                "name": uploaded["name"],
                "size": uploaded["size"],
                "mime": uploaded["mime"],
            },
        }
        if caption:
            payload["caption"] = str(caption)[:800]
        if reply_to:
            payload["replyToId"] = reply_to
        if buttons is not None:
            payload["buttons"] = buttons
        result = self._call("bot:sendFile", payload, timeout)
        return result.get("messageId")

    def send_voice(
        self,
        chat_id: str,
        source: Any,
        *,
        reply_to: Optional[str] = None,
        timeout: float = 30,
    ) -> Optional[str]:
        uploaded = self.upload(source)
        payload: dict[str, Any] = {
            "chatId": chat_id,
            "file": {
                "url": uploaded["url"],
                "name": uploaded["name"],
                "size": uploaded["size"],
                "mime": uploaded["mime"],
            },
        }
        if reply_to:
            payload["replyToId"] = reply_to
        result = self._call("bot:sendVoice", payload, timeout)
        return result.get("messageId")

    def join_voice(self, channel_id: str) -> dict[str, Any]:
        """Войти в голосовой канал группы; вернёт состав и LiveKit-токен."""
        result = self._call("bot:voiceJoin", {"channelId": channel_id}, 20)
        self.voice = {
            "channelId": result.get("channelId"),
            "livekit": result.get("livekit"),
            "members": result.get("members") or [],
        }
        return result

    def leave_voice(self) -> dict[str, Any]:
        result = self._call("bot:voiceLeave", {}, 20)
        self.voice = None
        return result

    def voice_members(self, channel_id: str) -> dict[str, Any]:
        result = self._call("bot:voiceMembers", {"channelId": channel_id}, 15)
        if self.voice and self.voice.get("channelId") == channel_id:
            self.voice["members"] = result.get("members") or []
        return result

    def set_voice_media(
        self,
        *,
        muted: Optional[bool] = None,
        deafened: Optional[bool] = None,
        camera_off: Optional[bool] = None,
        sharing_screen: Optional[bool] = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if muted is not None:
            payload["muted"] = bool(muted)
        if deafened is not None:
            payload["deafened"] = bool(deafened)
        if camera_off is not None:
            payload["cameraOff"] = bool(camera_off)
        if sharing_screen is not None:
            payload["sharingScreen"] = bool(sharing_screen)
        result = self._call("bot:voiceMedia", payload, 15)
        if self.voice:
            for key in ("muted", "deafened", "cameraOff", "sharingScreen"):
                if key in result:
                    self.voice[key] = result[key]
        return result

    def voice_channels(self, chat_id: Optional[str] = None) -> list[dict[str, Any]]:
        if not any(chat.get("voiceChannels") for chat in self.chats):
            self.fetch_chats()
        if chat_id:
            for chat in self.chats:
                if chat.get("id") == chat_id:
                    return chat.get("voiceChannels") or []
            return []
        channels: list[dict[str, Any]] = []
        for chat in self.chats:
            for channel in chat.get("voiceChannels") or []:
                channels.append({**channel, "chatId": chat.get("id"), "chatTitle": chat.get("title")})
        return channels

    def typing(self, chat_id: str, is_typing: bool = True) -> None:
        self._sio.emit("bot:typing", {"chatId": chat_id, "isTyping": bool(is_typing)})

    def fetch_chats(self) -> list[dict[str, Any]]:
        result = self._call("bot:chats", {}, 15)
        self.chats = result.get("chats") or []
        return self.chats

    def history(self, chat_id: str, before: Optional[str] = None, timeout: float = 15) -> dict[str, Any]:
        payload: dict[str, Any] = {"chatId": chat_id}
        if before:
            payload["before"] = before
        return self._call("bot:history", payload, timeout)

    # --- внутреннее ------------------------------------------------------
    def _call(self, event: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        # Ack ждём из рабочего потока: главный поток занят чтением сокета.
        try:
            result = self._sio.call(event, payload, timeout=timeout)
        except SocketTimeoutError as error:
            raise BotError(f"Сервер не ответил на {event}") from error
        if not result or not result.get("ok"):
            error = (result or {}).get("error") or f"Ошибка запроса {event}"
            raise BotError(str(error))
        return result

    def _chat_type(self, chat_id: str) -> str:
        for chat in self.chats:
            if chat.get("id") == chat_id or chat_id in (chat.get("rooms") or []):
                return str(chat.get("type") or "group")
        return "dm" if str(chat_id).startswith("dm_") else "group"

    def _dispatch(self, handler: Callable[[BotContext], Any], ctx: BotContext) -> None:
        def run() -> None:
            try:
                handler(ctx)
            except Exception as error:  # noqa: BLE001 — один сбой не должен ломать бота
                self._logger(f"[bot] ошибка обработчика: {type(error).__name__}: {error}")

        self._pool.submit(run)

    def _command_from(self, raw: Any) -> Optional[BotCommand]:
        if not isinstance(raw, dict) or not raw.get("name"):
            return None
        return BotCommand(
            name=str(raw.get("name")).lower(),
            args=str(raw.get("args") or ""),
            target=raw.get("target"),
            addressed=bool(raw.get("addressed")),
        )

    def _context_from_message(self, message: dict[str, Any]) -> BotContext:
        sender = message.get("from") or {}
        return BotContext(
            self,
            chat_id=str(message.get("chatId") or message.get("room") or ""),
            chat_type=self._chat_type(str(message.get("chatId") or message.get("room") or "")),
            message=message,
            command=self._command_from(message.get("command")),
            message_id=message.get("id"),
            sender=BotSender(
                id=sender.get("id") or message.get("authorId"),
                name=sender.get("name") or message.get("author"),
                username=sender.get("username"),
            ),
            text=str(message.get("text") or ""),
        )

    def _sync_commands(self) -> None:
        try:
            if not self._command_descriptions:
                return
            commands = [
                {"command": name, "description": text}
                for name, text in self._command_descriptions.items()
            ]
            self._call("bot:setCommands", {"commands": commands}, 15)
        except Exception as error:  # noqa: BLE001 — не роняем бота из-за меню
            self._logger(f"[bot] не удалось обновить команды: {error}")
        finally:
            self._commands_synced.set()

    def _register_events(self) -> None:
        @self._sio.event
        def connect() -> None:  # noqa: ANN001 — имя события задаёт socketio
            self._logger(f"[bot] подключаюсь к {self.url}")

        @self._sio.event
        def disconnect() -> None:  # noqa: ANN001
            self._logger("[bot] соединение закрыто")

        @self._sio.on("bot:ready")
        def on_ready(payload: dict[str, Any]) -> None:  # noqa: ANN001
            self.me = payload.get("bot") or {}
            self.chats = payload.get("chats") or []
            self._logger(f"[bot] на связи как @{self.me.get('username')}")
            self._ready.set()
            self._dispatch(lambda _ctx: self._sync_commands(), BotContext(self, chat_id=""))
            for handler in self._ready_handlers:
                self._dispatch(lambda _ctx, fn=handler: fn(self), BotContext(self, chat_id=""))

        @self._sio.on("message")
        def on_message(message: dict[str, Any]) -> None:  # noqa: ANN001
            if not isinstance(message, dict):
                return
            ctx = self._context_from_message(message)
            command = ctx.command
            if command and command.addressed:
                handlers = list(self._command_handlers.get(command.name, []))
                handlers += self._command_handlers.get("*", [])
                for handler in handlers:
                    self._dispatch(handler, ctx)
            for handler in self._message_handlers:
                self._dispatch(handler, ctx)

        @self._sio.on("bot:callback")
        def on_callback(payload: dict[str, Any]) -> None:  # noqa: ANN001
            if not isinstance(payload, dict):
                return
            sender = payload.get("from") or {}
            chat_id = str(payload.get("chatId") or "")
            ctx = BotContext(
                self,
                chat_id=chat_id,
                chat_type=self._chat_type(chat_id),
                button_data=str(payload.get("data") or ""),
                message_id=payload.get("messageId"),
                sender=BotSender(
                    id=sender.get("id"),
                    name=sender.get("name"),
                    username=sender.get("username"),
                ),
                text=str(payload.get("messageText") or ""),
            )
            for handler in self._button_handlers:
                self._dispatch(handler, ctx)

        @self._sio.on("bot:added")
        def on_added(payload: dict[str, Any]) -> None:  # noqa: ANN001
            self._logger(f"[bot] добавлен в чат: {payload.get('title') or payload.get('chatId')}")
            self._dispatch(lambda _ctx: self.fetch_chats(), BotContext(self, chat_id=""))

        @self._sio.on("bot:voiceState")
        def on_voice_state(payload: dict[str, Any]) -> None:  # noqa: ANN001
            if not isinstance(payload, dict):
                return
            for handler in list(self._voice_state_handlers):
                def run(fn: Callable[[dict[str, Any]], Any] = handler, data: dict[str, Any] = payload) -> None:
                    try:
                        fn(data)
                    except Exception as error:  # noqa: BLE001
                        self._logger(f"[bot] voice state: {type(error).__name__}: {error}")

                self._pool.submit(run)


def _file_payload(source: Any) -> tuple[str, bytes, str]:
    """Принимает путь к файлу, dict {"name","data","type"} или (name, bytes, mime)."""
    if isinstance(source, (str, pathlib.Path)):
        file_path = pathlib.Path(source)
        name = file_path.name
        data = file_path.read_bytes()
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return name, data, mime
    if isinstance(source, dict):
        name = str(source.get("name") or "file")
        raw = source.get("data", b"")
        data = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
        mime = str(source.get("type") or source.get("mime") or mimetypes.guess_type(name)[0] or "application/octet-stream")
        return name, data, mime
    if isinstance(source, (tuple, list)) and len(source) == 3:
        name, data, mime = source
        raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        return str(name), raw, str(mime)
    raise BotError("send_file: передайте путь, dict или (name, data, mime)")
