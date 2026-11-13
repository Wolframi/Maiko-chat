#!/usr/bin/env node
/**
 * Демонстрационный бот Майко: команды, инлайн-кнопки, ответы и отправка файлов.
 *
 *   node site/bots/echo-bot.mjs --token maiko_bot_...
 *   MAIKO_URL=http://127.0.0.1:3000 MAIKO_BOT_TOKEN=... node site/bots/echo-bot.mjs
 *
 * Команды: /start, /help, /menu, /echo, /roll, /time, /id, /file.
 * В группе адресуйте их боту: /help@echo_bot.
 */
import { createBot } from "./maiko-bot.mjs";

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const token = arg("token") || process.env.MAIKO_BOT_TOKEN;
const url = arg("url") || process.env.MAIKO_URL || "http://127.0.0.1:3000";
const avatarPath = arg("avatar");
if (!token) {
  console.error("Нужен токен: node site/bots/echo-bot.mjs --token maiko_bot_...");
  console.error("Создать бота: npm run bots:add -- --name \"Echo\"");
  process.exit(1);
}

const bot = createBot({ token, url });

function helpText() {
  const at = bot.me ? `@${bot.me.username}` : "@bot";
  return [
    "Я демо-бот Майко. Команды:",
    "/start — приветствие и кнопки",
    "/help — этот список",
    "/menu — меню на кнопках",
    "/echo <текст> — повторю текст",
    "/roll [N] — случайное число от 1 до N (по умолчанию 100)",
    "/time — время сервера",
    "/id — id чата и ваш id",
    "/file — пришлю текстовый файл",
    "",
    `В группе адресуйте команды: /help${at}`,
  ].join("\n");
}

function menuButtons() {
  return [
    [
      { text: "🎲 Бросок", data: "roll" },
      { text: "🕒 Время", data: "time" },
    ],
    [
      { text: "📎 Файл", data: "file" },
      { text: "ℹ️ О боте", data: "about" },
    ],
    [{ text: "🌐 Пример ссылки", url: "https://example.com/" }],
  ];
}

function backButtons() {
  return [
    [
      { text: "🎲 Ещё раз", data: "roll" },
      { text: "↩️ В меню", data: "menu" },
    ],
  ];
}

function roll(max = 100) {
  return 1 + Math.floor(Math.random() * max);
}

async function beginTyping(ctx) {
  try {
    await ctx.typing();
    await new Promise((resolve) => setTimeout(resolve, 250));
  } catch {
    /* typing is cosmetic */
  }
}

async function endTyping(ctx) {
  try {
    await ctx.stopTyping();
  } catch {
    /* ignore */
  }
}

/** Один и тот же файл для команды /file и для кнопки «Файл». */
async function sendReportFile(ctx) {
  const stamp = new Date().toISOString();
  const body = [
    "Файл от демо-бота Майко",
    `Создан: ${stamp}`,
    `Чат: ${ctx.chatId}`,
    `Запросил: ${ctx.from?.name || "—"} (${ctx.from?.id || "—"})`,
    "",
    "Боты умеют отправлять любые файлы: документы, фото, видео, аудио.",
  ].join("\n");
  await ctx.sendFile(
    {
      name: `maiko-bot-${Date.now()}.txt`,
      type: "text/plain",
      data: Buffer.from(body, "utf8"),
    },
    { caption: "Готово — файл от бота." },
  );
}

bot.onCommand("start", async (ctx) => {
  await beginTyping(ctx);
  await ctx.reply(
    `Привет, ${ctx.from.name || "друг"}! Я ${bot.me?.displayName || "демо-бот"}.\n\n` +
      "Нажмите кнопку ниже или напишите /help.",
    { buttons: menuButtons() },
  );
  await endTyping(ctx);
}, "Приветствие и меню");

bot.onCommand("menu", async (ctx) => {
  await ctx.reply("Что показать?", { buttons: menuButtons() });
}, "Меню на кнопках");

bot.onCommand("help", async (ctx) => {
  await beginTyping(ctx);
  await ctx.reply(helpText());
  await endTyping(ctx);
}, "Список команд");

bot.onCommand("echo", async (ctx) => {
  if (!ctx.command.args) {
    await ctx.reply("Напишите так: /echo привет");
    return;
  }
  await ctx.reply(ctx.command.args);
}, "Повторить текст: /echo привет");

bot.onCommand("roll", async (ctx) => {
  const raw = Number.parseInt(ctx.command.args, 10);
  const max = Number.isFinite(raw) ? Math.min(Math.max(raw, 2), 1_000_000) : 100;
  await ctx.reply(`🎲 ${roll(max)} (из ${max})`);
}, "Случайное число: /roll 20");

bot.onCommand("time", async (ctx) => {
  const now = new Date();
  await ctx.reply(
    `Сервер: ${now.toLocaleString("ru-RU", { timeZoneName: "short" })}\n` +
      `UTC: ${now.toISOString()}`,
  );
}, "Время сервера");

bot.onCommand("id", async (ctx) => {
  await ctx.reply(`Чат: ${ctx.chatId}\nТип: ${ctx.chatType}\nВы: ${ctx.from.id}`);
}, "id чата и пользователя");

bot.onCommand("file", async (ctx) => {
  await beginTyping(ctx);
  try {
    await sendReportFile(ctx);
  } finally {
    await endTyping(ctx);
  }
}, "Прислать текстовый файл");

// Нажатия на инлайн-кнопки. Telegram-стиль: правим то же сообщение.
bot.onButton(async (ctx) => {
  if (ctx.data === "roll") {
    await ctx.edit({
      text: `🎲 Выпало ${roll()} (из 100)`,
      buttons: backButtons(),
    });
    return;
  }
  if (ctx.data === "time") {
    const now = new Date();
    await ctx.edit({
      text: `🕒 ${now.toLocaleString("ru-RU", { timeZoneName: "short" })}\nUTC: ${now.toISOString()}`,
      buttons: [[{ text: "↩️ В меню", data: "menu" }]],
    });
    return;
  }
  if (ctx.data === "about") {
    await ctx.edit({
      text:
        "Это пример бота на JavaScript из репозитория Майко.\n" +
        "Он общается с сервером по токену, умеет команды, кнопки и файлы.\n" +
        "Исходники: site/bots/echo-bot.mjs",
      buttons: [[{ text: "↩️ В меню", data: "menu" }]],
    });
    return;
  }
  if (ctx.data === "file") {
    await sendReportFile(ctx);
    return;
  }
  if (ctx.data === "menu") {
    await ctx.edit({ text: "Что показать?", buttons: menuButtons() });
  }
});

// Обычные сообщения: в личке подскажем команды, в группах не мешаем.
bot.onMessage(async (ctx) => {
  if (ctx.command) return;
  if (ctx.chatType === "dm" && ctx.text.trim()) {
    await ctx.reply("Напишите /help или откройте /menu.", {
      buttons: [[{ text: "📋 Меню", data: "menu" }]],
    });
  }
});

bot.onReady(async () => {
  try {
    await bot.setProfile({
      description:
        "Демо-бот Майко: команды, кнопки и файлы. Исходник: site/bots/echo-bot.mjs.",
      ...(avatarPath ? { avatar: avatarPath } : {}),
    });
    console.log("[echo-bot] описание" + (avatarPath ? " и аватар" : "") + " обновлены");
  } catch (error) {
    console.warn("[echo-bot] профиль не обновлён:", error?.message || error);
  }
  if (bot.chats.length) {
    console.log("[echo-bot] чаты:");
    for (const chat of bot.chats) {
      console.log(`  ${chat.type === "dm" ? "ЛС" : "группа"}: ${chat.title} (${chat.id})`);
    }
  } else {
    console.log("[echo-bot] пока нет чатов — напишите боту в «Людях» или добавьте его в группу.");
  }
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
