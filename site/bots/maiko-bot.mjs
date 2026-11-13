/**
 * Small Maiko bot SDK — no dependencies except socket.io-client.
 *
 *   import { createBot } from "./maiko-bot.mjs";
 *   const bot = createBot({ token: process.env.MAIKO_BOT_TOKEN });
 *   bot.onCommand("help", (ctx) => ctx.reply("Команды: /help, /echo"));
 *   bot.onMessage((ctx) => { if (!ctx.command) ctx.reply("Напиши /help"); });
 *
 * Bots receive every new message of the chats they belong to; a `/command`
 * also arrives as `ctx.command` with `{ name, args, target, addressed }`.
 * In groups commands must be addressed (`/help@my_bot`); in a direct chat a
 * plain `/help` is already addressed.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { io } from "socket.io-client";

const DEFAULT_URL = process.env.MAIKO_URL || "http://127.0.0.1:3000";
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

function guessMime(name) {
  return MIME_BY_EXT[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";
}

function normalizeCommandName(name) {
  return String(name || "").replace(/^\//, "").trim().toLowerCase();
}

export function createBot({ token, url = DEFAULT_URL, logger = console } = {}) {
  if (!token) throw new Error("createBot: нужен токен бота (npm run bots:add)");
  const baseUrl = String(url).replace(/\/+$/, "");

  const socket = io(baseUrl, {
    path: "/api/socket",
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelayMax: 10000,
    auth: { botToken: token },
  });

  const messageHandlers = [];
  const buttonHandlers = [];
  const voiceStateHandlers = [];
  const commandHandlers = new Map();
  /** Declared command list: name → description (Telegram BotFather-style). */
  const declaredCommands = new Map();
  let me = null;
  let chats = [];
  let voice = null;

  function rememberCommand(name, description = "") {
    const text = String(description || "").trim().slice(0, 120);
    if (text || !declaredCommands.has(name)) declaredCommands.set(name, text);
  }

  function declaredCommandList() {
    return [...declaredCommands].map(([command, description]) => ({ command, description }));
  }

  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function chatFor(roomId) {
    return chats.find((chat) => chat.id === roomId || (chat.rooms || []).includes(roomId)) || null;
  }

  async function emitAck(event, payload) {
    const result = await socket.timeout(15000).emitWithAck(event, payload);
    if (!result || result.ok !== true) {
      throw new Error(result?.error || `Бот: ошибка запроса ${event}`);
    }
    return result;
  }

  async function upload(source, options = {}) {
    const form = new FormData();
    let blob;
    let name;
    if (typeof source === "string") {
      const data = await readFile(source);
      name = path.basename(source);
      blob = new Blob([data], { type: guessMime(name) });
    } else if (source && typeof source === "object" && source.data !== undefined) {
      name = String(source.name || "file");
      blob = new Blob([source.data], {
        type: String(source.type || source.mime || guessMime(name)),
      });
    } else {
      throw new Error("sendFile: передайте путь к файлу или { name, data, type }");
    }
    form.append("originalName", name);
    form.append("file", blob, name);
    const query = options.avatar ? "?kind=avatar" : "";
    const response = await fetch(`${baseUrl}/api/upload${query}`, {
      method: "POST",
      headers: { "x-bot-token": token },
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Загрузка не удалась (${response.status})`);
    }
    return data.file;
  }

  const bot = {
    socket,
    ready,
    get me() {
      return me;
    },
    get chats() {
      return chats;
    },
    get voice() {
      return voice;
    },
    url: baseUrl,
    onReady(handler) {
      ready.then(handler).catch(() => {});
      return bot;
    },
    onMessage(handler) {
      if (typeof handler === "function") messageHandlers.push(handler);
      return bot;
    },
    /** Нажатие на инлайн-кнопку (`message:button` → `bot:callback`). */
    onButton(handler) {
      if (typeof handler === "function") buttonHandlers.push(handler);
      return bot;
    },
    /** Изменения состава голосового канала группы (`bot:voiceState`). */
    onVoiceState(handler) {
      if (typeof handler === "function") voiceStateHandlers.push(handler);
      return bot;
    },
    /** `name` without the slash; `"*"` receives every command. */
    onCommand(name, handler, description = "") {
      if (typeof handler !== "function") return bot;
      const key = name === "*" ? "*" : normalizeCommandName(name);
      const list = commandHandlers.get(key) || [];
      list.push(handler);
      commandHandlers.set(key, list);
      if (key !== "*") rememberCommand(key, description);
      return bot;
    },

    /** Declare the command list users see (command menu and clickable text). */
    async setCommands(commands) {
      const normalized = (Array.isArray(commands) ? commands : [])
        .map((item) =>
          typeof item === "string"
            ? { command: normalizeCommandName(item), description: "" }
            : {
                command: normalizeCommandName(item?.command),
                description: String(item?.description || "").slice(0, 120),
              },
        )
        .filter((item) => item.command);
      declaredCommands.clear();
      for (const item of normalized) declaredCommands.set(item.command, item.description);
      if (!socket.connected) return normalized;
      const result = await emitAck("bot:setCommands", { commands: normalized });
      return result.commands || normalized;
    },

    /**
     * Bot profile from the script: `{ description, displayName, avatar }`.
     * `avatar` is a file path or `{ name, data, type }`; it is uploaded for the bot.
     */
    async setProfile(profile = {}) {
      const payload = {};
      if (profile.description !== undefined) {
        payload.description = String(profile.description ?? "").slice(0, 512);
      }
      if (profile.displayName !== undefined) {
        payload.displayName = String(profile.displayName);
      }
      if (profile.avatar) {
        const uploaded = await upload(profile.avatar, { avatar: true });
        payload.avatarUrl = uploaded.url;
      } else if (profile.avatarUrl !== undefined) {
        payload.avatarUrl = profile.avatarUrl;
      }
      const result = await emitAck("bot:setProfile", payload);
      if (result.bot) me = result.bot;
      return result.bot;
    },

    async setDescription(text) {
      return bot.setProfile({ description: text });
    },

    async setAvatar(source) {
      return bot.setProfile({ avatar: source });
    },
    async sendMessage(chatId, text, options = {}) {
      const result = await emitAck("bot:send", {
        chatId,
        text,
        ...(options.replyToId ? { replyToId: options.replyToId } : {}),
        ...(options.clientId ? { clientId: options.clientId } : {}),
        ...(options.buttons ? { buttons: options.buttons } : {}),
      });
      return result.messageId;
    },
    async sendFile(chatId, source, options = {}) {
      const uploaded = await upload(source);
      const result = await emitAck("bot:sendFile", {
        chatId,
        file: {
          url: uploaded.url,
          name: uploaded.name,
          size: uploaded.size,
          mime: uploaded.mime,
        },
        ...(options.caption ? { caption: options.caption } : {}),
        ...(options.replyToId ? { replyToId: options.replyToId } : {}),
        ...(options.buttons ? { buttons: options.buttons } : {}),
      });
      return result.messageId;
    },
    /** Голосовое сообщение (аудиофайл с waveform-плеером). */
    async sendVoice(chatId, source, options = {}) {
      const uploaded = await upload(source);
      const result = await emitAck("bot:sendVoice", {
        chatId,
        file: {
          url: uploaded.url,
          name: uploaded.name,
          size: uploaded.size,
          mime: uploaded.mime,
        },
        ...(options.replyToId ? { replyToId: options.replyToId } : {}),
      });
      return result.messageId;
    },
    /** Войти в голосовой канал группы; вернёт состав и LiveKit-токен. */
    async joinVoice(channelId) {
      const result = await emitAck("bot:voiceJoin", { channelId });
      voice = {
        channelId: result.channelId,
        livekit: result.livekit || null,
        members: result.members || [],
      };
      return result;
    },
    async leaveVoice() {
      const result = await emitAck("bot:voiceLeave", {});
      voice = null;
      return result;
    },
    /** Сколько человек (и ботов) сейчас в голосовом канале. */
    async voiceMembers(channelId) {
      const result = await emitAck("bot:voiceMembers", { channelId });
      if (voice && voice.channelId === channelId) voice.members = result.members || [];
      return result;
    },
    /** mute/deafen/cameraOff/sharingScreen — отражается в составе канала. */
    async voiceMedia(flags = {}) {
      const result = await emitAck("bot:voiceMedia", flags);
      if (voice) {
        Object.assign(voice, {
          muted: result.muted,
          deafened: result.deafened,
          cameraOff: result.cameraOff,
          sharingScreen: result.sharingScreen,
        });
      }
      return result;
    },
    /** Голосовые каналы из списка чатов (можно отфильтровать по chatId). */
    async voiceChannels(chatId) {
      if (!chats.some((chat) => chat.voiceChannels)) await bot.refreshChats();
      if (chatId) {
        return chats.find((chat) => chat.id === chatId)?.voiceChannels || [];
      }
      return chats.flatMap((chat) =>
        (chat.voiceChannels || []).map((channel) => ({
          ...channel,
          chatId: chat.id,
          chatTitle: chat.title,
        })),
      );
    },
    /**
     * Edit a message the bot sent. `buttons: []` removes the keyboard;
     * omitting `buttons` keeps it.
     */
    async editMessage(chatId, messageId, patch = {}) {
      const payload = { chatId, messageId };
      if (patch.text !== undefined) payload.text = patch.text;
      if (patch.buttons !== undefined) payload.buttons = patch.buttons;
      const result = await emitAck("bot:edit", payload);
      return result.messageId;
    },
    typing(chatId, isTyping = true) {
      socket.emit("bot:typing", { chatId, isTyping: Boolean(isTyping) });
    },
    async refreshChats() {
      const result = await emitAck("bot:chats", {});
      chats = result.chats || [];
      return chats;
    },
    async history(chatId, options = {}) {
      const result = await emitAck("bot:history", {
        chatId,
        ...(options.before ? { before: options.before } : {}),
      });
      return { messages: result.messages || [], hasMore: Boolean(result.hasMore), before: result.before };
    },
    async join() {
      const result = await emitAck("bot:join", {});
      chats = result.chats || [];
      return chats;
    },
    /** Войти в группу по коду приглашения (как «код» в профиле группы). */
    async joinGroup(code) {
      const result = await emitAck("bot:joinGroup", {
        code: String(code || ""),
      });
      try {
        await bot.refreshChats();
      } catch {
        /* чаты обновятся следующим bot:chats */
      }
      return result;
    },
    stop() {
      socket.disconnect();
    },
  };

  socket.on("connect_error", (error) => {
    logger.warn?.(`[bot] подключение не удалось: ${error?.message || error}`);
  });

  socket.on("disconnect", (reason) => {
    if (reason !== "io client disconnect") logger.warn?.(`[bot] отключён: ${reason}`);
  });

  socket.on("bot:added", (payload) => {
    logger.log?.(`[bot] добавлен в чат ${payload?.title || payload?.chatId}`);
    bot.refreshChats().catch(() => {});
  });

  socket.on("bot:ready", async (payload) => {
    me = payload?.bot || null;
    chats = payload?.chats || [];
    if (!declaredCommands.size && Array.isArray(me?.commands)) {
      for (const item of me.commands) {
        if (item?.command) rememberCommand(item.command, item.description);
      }
    }
    if (declaredCommands.size) {
      try {
        await emitAck("bot:setCommands", { commands: declaredCommandList() });
      } catch (error) {
        logger.warn?.(`[bot] не удалось обновить команды: ${error?.message || error}`);
      }
    }
    logger.log?.(`[bot] на связи как @${me?.username} (@${baseUrl})`);
    resolveReady(bot);
  });

  socket.on("message", (message) => {
    if (!message || !message.room) return;
    const command = message.command || null;
    const call = {
      message,
      chatId: message.room,
      chatType: chatFor(message.room)?.type || (message.room.startsWith("dm_") ? "dm" : "group"),
      chat: chatFor(message.room),
      text: message.text || "",
      from: { id: message.authorId, name: message.author },
      command,
      reply: (text, options = {}) =>
        bot.sendMessage(message.room, text, { replyToId: message.id, ...options }),
      sendFile: (source, options = {}) =>
        bot.sendFile(message.room, source, {
          replyToId: message.id,
          // Allow `ctx.sendFile(file, "подпись")` as well as `{ caption }`.
          ...(typeof options === "string" ? { caption: options } : options),
        }),
      sendVoice: (source, options = {}) =>
        bot.sendVoice(message.room, source, { replyToId: message.id, ...options }),
      typing: () => bot.typing(message.room, true),
      stopTyping: () => bot.typing(message.room, false),
      history: (options = {}) => bot.history(message.room, options),
    };

    if (command && command.addressed) {
      const handlers = [
        ...(commandHandlers.get(command.name) || []),
        ...(commandHandlers.get("*") || []),
      ];
      for (const handler of handlers) {
        Promise.resolve(handler(call)).catch((error) => {
          logger.error?.(`[bot] команда /${command.name}:`, error?.message || error);
        });
      }
    }

    for (const handler of messageHandlers) {
      Promise.resolve(handler(call)).catch((error) => {
        logger.error?.("[bot] обработчик сообщения:", error?.message || error);
      });
    }
  });

  socket.on("bot:callback", (payload) => {    if (!payload || !payload.chatId) return;
    const call = {
      chatId: payload.chatId,
      chatType: payload.chatType,
      chat: chatFor(payload.chatId),
      messageId: payload.messageId,
      data: payload.data,
      from: payload.from,
      text: payload.messageText || "",
      reply: (text, options = {}) => bot.sendMessage(payload.chatId, text, options),
      edit: (patch = {}) => bot.editMessage(payload.chatId, payload.messageId, patch),
      sendFile: (source, options = {}) =>
        bot.sendFile(payload.chatId, source, {
          ...(typeof options === "string" ? { caption: options } : options),
        }),
      typing: () => bot.typing(payload.chatId, true),
      stopTyping: () => bot.typing(payload.chatId, false),
    };
    for (const handler of buttonHandlers) {
      Promise.resolve(handler(call)).catch((error) => {
        logger.error?.("[bot] обработчик кнопки:", error?.message || error);
      });
    }
  });

  socket.on("bot:voiceState", (payload) => {
    if (!payload || !Array.isArray(payload.channels)) return;
    for (const handler of voiceStateHandlers) {
      Promise.resolve(handler(payload)).catch((error) => {
        logger.error?.("[bot] voice state:", error?.message || error);
      });
    }
  });

  return bot;
}
