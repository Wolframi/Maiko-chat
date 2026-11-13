import { createHash } from "node:crypto";
import type { BotButton, BotCommandInfo } from "../lib/types";

/**
 * Bot protocol primitives shared by the server, the CLI and the bot SDK.
 * Dependency-free on purpose: no storage, no sockets, no auth — easy to unit test.
 */

/** Prefix every bot token starts with, so leaked values are recognisable. */
export const BOT_TOKEN_PREFIX = "maiko_bot_";
/** 24 random bytes → 48 hex characters after the prefix. */
export const BOT_TOKEN_BYTES = 24;
export const BOT_TOKEN_PATTERN = /^maiko_bot_[a-f0-9]{48}$/;

/** Bot messages are longer than human ones but still bounded. */
export const BOT_MAX_TEXT = 4000;
export const BOT_MAX_CAPTION = 800;
export const BOT_MAX_FILES = 10;

/** `/help`, `/roll 2d6`, `/help@weather_bot`. */
const BOT_COMMAND_PATTERN =
  /^\/([a-zA-Z0-9_]{1,32})(?:@([a-zA-Z0-9_-]{2,32}(?:\.[a-zA-Z0-9_-]{1,32})*))?(?:[ \t]+([\s\S]*))?$/;

export type ParsedBotCommand = {
  /** Lowercase name without the slash, e.g. `help`. */
  name: string;
  /** Everything after the command, trimmed. */
  args: string;
  /** Bot username from `/command@username`, lowercase, or null. */
  target: string | null;
};

export function isBotTokenFormat(value: unknown): value is string {
  return typeof value === "string" && BOT_TOKEN_PATTERN.test(value);
}

/** Only the hash is stored; the token itself is shown once at creation. */
export function botTokenHash(token: string) {
  return createHash("sha256").update(`maiko-bot-token:${token}`).digest("hex");
}

/** Safe to show in bot lists and logs. */
export function maskBotToken(token: string) {
  const value = String(token || "");
  if (value.length <= BOT_TOKEN_PREFIX.length + 12) return "…";
  return `${value.slice(0, BOT_TOKEN_PREFIX.length + 4)}…${value.slice(-4)}`;
}

/** Strip control characters and clamp — same hygiene as human messages. */
export function sanitizeBotText(value: unknown, max: number = BOT_MAX_TEXT) {
  const limit = Math.max(1, Math.floor(max));
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, limit);
}

/**
 * Parse a chat text as a bot command. Commands only count at the very start of
 * the message, like in Telegram; `/help me` yields args `me`.
 */
export function parseBotCommand(text: unknown): ParsedBotCommand | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value.startsWith("/")) return null;
  const match = BOT_COMMAND_PATTERN.exec(value);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: (match[3] || "").trim(),
    target: match[2] ? match[2].toLowerCase() : null,
  };
}

/**
 * A command is addressed to a bot when it names it (`/help@bot`) or when it
 * names nobody and the chat has exactly one bot anyway (private chat).
 * The caller decides the private-chat case; this helper handles the explicit one.
 */
export function commandAddressedTo(
  command: ParsedBotCommand | null | undefined,
  username: string,
) {
  if (!command) return false;
  if (!command.target) return false;
  return command.target === String(username || "").trim().toLowerCase();
}

/** `/start` and `/help` are recognised by every well-behaved bot. */
export const BOT_CORE_COMMANDS = ["start", "help"] as const;

/** Bot command list limits (Telegram-like, but compact for the chat UI). */
export const BOT_MAX_COMMANDS = 32;
export const BOT_MAX_COMMAND_DESCRIPTION = 120;
const BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

/**
 * Sanitize the command list a bot declares via `bot:setCommands`.
 * Returns `[]` to clear the list, or `null` when the payload is invalid.
 */
export function normalizeBotCommands(raw: unknown): BotCommandInfo[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > BOT_MAX_COMMANDS) return null;
  const commands = new Map<string, string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const entry = item as { command?: unknown; description?: unknown };
    const name = String(entry.command ?? "")
      .trim()
      .replace(/^\//, "")
      .toLowerCase();
    if (!BOT_COMMAND_NAME_PATTERN.test(name)) return null;
    const description = sanitizeBotText(
      entry.description,
      BOT_MAX_COMMAND_DESCRIPTION,
    ).replace(/\s+/g, " ");
    commands.set(name, description);
  }
  return [...commands].map(([command, description]) => ({ command, description }));
}

/** Inline keyboard limits — deliberately below Telegram's, for a narrow bubble. */
export const BOT_MAX_BUTTON_ROWS = 6;
export const BOT_MAX_BUTTONS_PER_ROW = 4;
export const BOT_MAX_BUTTON_TEXT = 64;
export const BOT_MAX_BUTTON_DATA = 64;
export const BOT_MAX_BUTTON_URL = 300;

function normalizeButtonUrl(value: unknown) {
  const url = String(value ?? "").trim().slice(0, BOT_MAX_BUTTON_URL);
  if (!url || /[\u0000-\u0020\u007F]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return url;
}

/**
 * Sanitize a bot's inline keyboard.
 * - `undefined` / `null` / `[]` → no keyboard (`undefined`);
 * - invalid shape, limits or a button without exactly one action → `null`.
 *
 * A button has either `data` (callback to the bot) or `url` (opened in browser).
 */
export function normalizeBotButtons(
  raw: unknown,
): BotButton[][] | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return undefined;
  if (raw.length > BOT_MAX_BUTTON_ROWS) return null;

  const rows: BotButton[][] = [];
  for (const rawRow of raw) {
    if (
      !Array.isArray(rawRow) ||
      rawRow.length === 0 ||
      rawRow.length > BOT_MAX_BUTTONS_PER_ROW
    ) {
      return null;
    }
    const row: BotButton[] = [];
    for (const rawButton of rawRow) {
      if (!rawButton || typeof rawButton !== "object") return null;
      const item = rawButton as { text?: unknown; data?: unknown; url?: unknown };
      const text = sanitizeBotText(item.text, BOT_MAX_BUTTON_TEXT).replace(/\s+/g, " ");
      if (!text) return null;

      const hasUrl = item.url !== undefined && item.url !== null && item.url !== "";
      const url = hasUrl ? normalizeButtonUrl(item.url) : null;
      if (hasUrl && !url) return null;

      const data = sanitizeBotText(item.data, BOT_MAX_BUTTON_DATA);
      if (url && data) return null;
      if (!url && !data) return null;

      row.push(url ? { text, url } : { text, data });
    }
    rows.push(row);
  }
  return rows;
}
