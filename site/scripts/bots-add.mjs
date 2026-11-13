#!/usr/bin/env node
/**
 * Manual bot administration for Maiko.
 *
 *   npm run bots:add -- --name "Погода" --username weather_bot
 *   npm run bots:add -- --name "Echo" --group "Моя группа"
 *   npm run bots:add -- --list
 *   npm run bots:add -- --rotate weather_bot
 *   npm run bots:add -- --remove weather_bot
 *
 * The script talks to the running server over the local admin secret
 * (data/bot-admin-secret.txt, created on first server start).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(name) {
  return args.includes(`--${name}`);
}

function usage() {
  console.log(`Maiko — боты (добавляются вручную)

  npm run bots:add -- --name "Погода" [--username weather_bot] [--group "Название"]
  npm run bots:add -- --bot weather_bot --group "Название"
  npm run bots:add -- --list
  npm run bots:add -- --rotate <id|username>
  npm run bots:add -- --remove <id|username>

Параметры:
  --name      Имя бота, которое увидят пользователи (обязательно для создания)
  --username  Логин бота: 3–24 символа, буквы/цифры/_.- (по умолчанию bot_xxxx)
  --bot       Существующий бот для --group
  --group     Группа: id (group_…) или точное название
  --avatar    Аватар: ссылка /uploads/… (png, jpg, gif, webp)
  --description  Описание бота (до 512 символов)
  --bio       Короткое описание профиля
  --owner     userId владельца (необязательно)
  --url       Адрес сервера, по умолчанию ${process.env.MAIKO_URL || "http://127.0.0.1:3000"}
  --help      Эта справка

Секрет управления берётся из BOT_ADMIN_SECRET или data/bot-admin-secret.txt.
Сначала запустите сервер (npm run dev), чтобы секрет создался.`);
}

const url = String(flag("url") || process.env.MAIKO_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
// Server data may live in site/ or in the repository root (cwd of server.ts).
const secretFile = [
  path.join(siteDir, "data", "bot-admin-secret.txt"),
  path.join(siteDir, "..", "data", "bot-admin-secret.txt"),
].find((candidate) => existsSync(candidate));
const secret = String(process.env.BOT_ADMIN_SECRET || "").trim()
  || (secretFile ? readFileSync(secretFile, "utf8").trim() : "");

async function call(action, payload = {}) {
  if (!secret) {
    throw new Error(
      "Не найден секрет управления ботами.\n" +
        "Запустите сервер один раз (npm run dev) — он создаст data/bot-admin-secret.txt,\n" +
        "или задайте BOT_ADMIN_SECRET.",
    );
  }
  let response;
  try {
    response = await fetch(`${url}/api/bots/admin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bot-admin-secret": secret,
      },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    throw new Error(`Сервер не отвечает на ${url}. Запустите его: npm run dev`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Сервер ответил ${response.status}`);
  }
  return data;
}

function describe(bot) {
  const last = bot.lastConnectedAt
    ? `, в сети ${new Date(bot.lastConnectedAt).toLocaleString("ru-RU")}`
    : "";
  return `  ${bot.displayName} (@${bot.username}) — id ${bot.botId}${last}`;
}

async function main() {
  if (!args.length || has("help")) {
    usage();
    return;
  }

  if (has("list")) {
    const { bots } = await call("list");
    if (!bots.length) {
      console.log("Ботов пока нет. Создайте: npm run bots:add -- --name \"Echo\"");
      return;
    }
    console.log(`Боты (${bots.length}):`);
    for (const bot of bots) console.log(describe(bot));
    return;
  }

  if (flag("bot") && flag("group")) {
    const result = await call("addToGroup", {
      botId: flag("bot"),
      groupId: flag("group"),
    });
    console.log(
      `${result.bot.displayName} (@${result.bot.username}) добавлен в группу ${result.groupId}`,
    );
    return;
  }

  if (has("remove") || has("rotate")) {
    const rotate = has("rotate");
    const target = flag(rotate ? "rotate" : "remove");
    if (!target || target.startsWith("--")) {
      throw new Error(`Укажите бота: --${rotate ? "rotate" : "remove"} <id|username>`);
    }
    const result = await call(rotate ? "rotate" : "remove", { botId: target });
    if (rotate) {
      console.log(`Новый токен для ${result.bot.displayName} (@${result.bot.username}):`);
      console.log("");
      console.log(`  ${result.token}`);
      console.log("");
      console.log("Старый токен больше не работает — перезапустите процесс бота.");
    } else {
      console.log(`Бот удалён: ${result.bot.displayName} (@${result.bot.username})`);
      console.log("История его сообщений осталась в чатах.");
    }
    return;
  }

  const name = flag("name");
  if (!name) {
    throw new Error("Укажите имя бота: --name \"Погода\" (справка: --help)");
  }

  const created = await call("create", {
    displayName: name,
    username: flag("username"),
    bio: flag("bio"),
    avatarUrl: flag("avatar"),
    description: flag("description"),
    ownerId: flag("owner"),
    groupId: flag("group"),
  });

  console.log(`Бот создан: ${created.bot.displayName} (@${created.bot.username})`);
  console.log(`id: ${created.bot.botId}`);
  if (created.groupId) console.log(`Добавлен в группу: ${created.groupId}`);
  console.log("");
  console.log("Токен (показывается один раз, сохраните его):");
  console.log("");
  console.log(`  ${created.token}`);
  console.log("");
  console.log("Демо-бот:");
  console.log(`  node site/bots/echo-bot.mjs --token ${created.token}`);
  console.log("");
  console.log("Написать боту можно из вкладки «Люди» — он ищется по логину.");
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exitCode = 1;
});
