import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BOT_TOKEN_BYTES,
  BOT_TOKEN_PREFIX,
  botTokenHash,
  isBotTokenFormat,
  maskBotToken,
  normalizeBotCommands,
  sanitizeBotText,
} from "./botProtocol";
import type { BotCommandInfo } from "../lib/types";
import { createBotUser, getUserById, removeBotUser } from "./auth";

/**
 * Manual bot registry (data/bots.json).
 *
 * Bots are created by an administrator — via `npm run bots:add` or the local
 * admin HTTP endpoint — and then connect to the server with their token.
 * Plaintext tokens are never stored: only a SHA-256 hash survives creation.
 */

export type BotRecord = {
  botId: string;
  username: string;
  displayName: string;
  ownerId?: string;
  createdAt: number;
  tokenHash: string;
  tokenPreview: string;
  lastConnectedAt?: number;
  /** Shown in the bot DM and chat info. */
  description?: string;
  /** Telegram-style command list, declared by the bot script. */
  commands?: BotCommandInfo[];
};

export type BotPublic = {
  botId: string;
  username: string;
  displayName: string;
  ownerId?: string;
  createdAt: number;
  tokenPreview: string;
  lastConnectedAt?: number;
  description?: string;
  commands?: BotCommandInfo[];
  avatarUrl?: string;
};

export type BotCreateInput = {
  displayName?: unknown;
  username?: unknown;
  bio?: unknown;
  avatarUrl?: unknown;
  ownerId?: unknown;
  description?: unknown;
};

type CreateBotResult =
  | { ok: true; bot: BotPublic; token: string }
  | { ok: false; error: string };

const DATA_DIR = path.join(process.cwd(), "data");
const BOTS_FILE = path.join(DATA_DIR, "bots.json");
const ADMIN_SECRET_FILE = path.join(DATA_DIR, "bot-admin-secret.txt");
const MAX_BOTS = 200;
const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]{3,24}$/u;
/** Re-connecting bots must not rewrite bots.json on every socket. */
const LAST_CONNECT_PERSIST_MS = 5 * 60_000;

const bots = new Map<string, BotRecord>();
let loaded = false;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** Atomic replace — a torn bots.json would lose every token at once. */
function atomicWriteJson(filePath: string, payload: unknown, mode?: number) {
  ensureDataDir();
  const body = JSON.stringify(payload, null, 2);
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8", ...(mode ? { mode } : {}) });
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, body, { encoding: "utf8", ...(mode ? { mode } : {}) });
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function isRecord(value: unknown): value is BotRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BotRecord>;
  return (
    typeof candidate.botId === "string" &&
    Boolean(candidate.botId) &&
    typeof candidate.username === "string" &&
    Boolean(candidate.username) &&
    typeof candidate.displayName === "string" &&
    typeof candidate.tokenHash === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.tokenHash) &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.tokenPreview === "string"
  );
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!existsSync(BOTS_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(BOTS_FILE, "utf8")) as unknown;
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      bots.set(entry.botId, entry);
    }
  } catch (error) {
    console.error("[bots] cannot read bots.json", (error as Error).name);
  }
}

function saveBots() {
  atomicWriteJson(BOTS_FILE, [...bots.values()]);
}

export function publicBot(record: BotRecord): BotPublic {
  const user = getUserById(record.botId);
  return {
    botId: record.botId,
    username: record.username,
    displayName: record.displayName,
    ...(record.ownerId ? { ownerId: record.ownerId } : {}),
    createdAt: record.createdAt,
    tokenPreview: record.tokenPreview,
    ...(record.lastConnectedAt ? { lastConnectedAt: record.lastConnectedAt } : {}),
    ...(record.description ? { description: record.description } : {}),
    ...(record.commands?.length ? { commands: record.commands } : {}),
    ...(user?.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

export function listBots(): BotPublic[] {
  ensureLoaded();
  return [...bots.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(publicBot);
}

export function findBot(botId: string): BotRecord | undefined {
  ensureLoaded();
  return bots.get(String(botId || ""));
}

export function findBotByUsername(username: string): BotRecord | undefined {
  ensureLoaded();
  const key = String(username || "").trim().toLowerCase();
  if (!key) return undefined;
  for (const record of bots.values()) {
    if (record.username.toLowerCase() === key) return record;
  }
  return undefined;
}

export function isBotUserId(userId: string | undefined | null): boolean {
  if (!userId) return false;
  ensureLoaded();
  return bots.has(String(userId));
}

function newToken() {
  return `${BOT_TOKEN_PREFIX}${randomBytes(BOT_TOKEN_BYTES).toString("hex")}`;
}

/**
 * Creates the user record first, then the registry entry. If the registry write
 * fails the user is rolled back, so a bot never exists without a token.
 */
export async function createBot(input: BotCreateInput): Promise<CreateBotResult> {
  ensureLoaded();
  if (bots.size >= MAX_BOTS) {
    return { ok: false, error: `На сервере уже ${MAX_BOTS} ботов — это предел` };
  }
  const displayName = sanitizeBotText(input?.displayName, 32).replace(/\s+/g, " ");
  if (displayName.length < 2) {
    return { ok: false, error: "Укажите имя бота (от 2 символов): --name \"Погода\"" };
  }
  const username = sanitizeBotText(input?.username, 24) || `bot_${randomBytes(3).toString("hex")}`;
  if (!USERNAME_PATTERN.test(username)) {
    return {
      ok: false,
      error: "Логин бота: 3–24 символа, буквы, цифры, _ . -",
    };
  }
  if (findBotByUsername(username)) {
    return { ok: false, error: "Бот с таким логином уже существует" };
  }
  const avatarUrl = sanitizeBotText(input?.avatarUrl, 240);
  if (avatarUrl && !/^\/uploads\/[0-9a-f-]{36}(?:_[^/\\]+)?\.(png|jpe?g|gif|webp)$/i.test(avatarUrl.split("?")[0])) {
    return { ok: false, error: "Аватар бота — ссылка вида /uploads/…png|jpg|gif|webp" };
  }
  const ownerId = sanitizeBotText(input?.ownerId, 64) || undefined;
  const description = sanitizeBotText(input?.description, 512);

  const created = await createBotUser({
    username,
    displayName,
    bio: sanitizeBotText(input?.bio, 120),
    ownerId,
    ...(avatarUrl ? { avatarUrl } : {}),
  });
  if (!created.ok) return { ok: false, error: created.error };

  const token = newToken();
  const record: BotRecord = {
    botId: created.user.id,
    username: created.user.username,
    displayName: created.user.displayName || created.user.username,
    ...(ownerId ? { ownerId } : {}),
    createdAt: Date.now(),
    tokenHash: botTokenHash(token),
    tokenPreview: maskBotToken(token),
    ...(description ? { description } : {}),
  };
  bots.set(record.botId, record);
  try {
    saveBots();
  } catch (error) {
    bots.delete(record.botId);
    try {
      removeBotUser(record.botId);
    } catch {
      /* best effort rollback */
    }
    throw error;
  }
  return { ok: true, bot: publicBot(record), token };
}

export function removeBot(botId: string): { ok: true; bot: BotPublic } | { ok: false; error: string } {
  ensureLoaded();
  const record = bots.get(String(botId || ""));
  if (!record) return { ok: false, error: "Бот не найден" };
  bots.delete(record.botId);
  try {
    saveBots();
  } catch (error) {
    bots.set(record.botId, record);
    throw error;
  }
  removeBotUser(record.botId);
  return { ok: true, bot: publicBot(record) };
}

/** Old token stops working immediately; connected bots must reconnect. */
export function rotateBotToken(
  botId: string,
): { ok: true; bot: BotPublic; token: string } | { ok: false; error: string } {
  ensureLoaded();
  const record = bots.get(String(botId || ""));
  if (!record) return { ok: false, error: "Бот не найден" };
  const token = newToken();
  const next: BotRecord = {
    ...record,
    tokenHash: botTokenHash(token),
    tokenPreview: maskBotToken(token),
  };
  bots.set(record.botId, next);
  try {
    saveBots();
  } catch (error) {
    bots.set(record.botId, record);
    throw error;
  }
  return { ok: true, bot: publicBot(next), token };
}

/**
 * Constant-time comparison over every stored hash. The registry is small
 * (hundreds at most) and tokens are rate-limited at the socket boundary.
 */
export function resolveBotToken(token: unknown): BotRecord | null {
  ensureLoaded();
  if (!isBotTokenFormat(token)) return null;
  const provided = Buffer.from(botTokenHash(token), "hex");
  let matched: BotRecord | null = null;
  for (const record of bots.values()) {
    const stored = Buffer.from(record.tokenHash, "hex");
    if (stored.length !== provided.length) continue;
    if (timingSafeEqual(stored, provided)) matched = record;
  }
  if (!matched) return null;
  // Registry and account must agree: a half-deleted bot cannot act.
  return getUserById(matched.botId)?.isBot ? matched : null;
}

export function markBotConnected(botId: string, now = Date.now()) {
  ensureLoaded();
  const record = bots.get(botId);
  if (!record) return;
  if (record.lastConnectedAt && now - record.lastConnectedAt < LAST_CONNECT_PERSIST_MS) return;
  record.lastConnectedAt = now;
  try {
    saveBots();
  } catch (error) {
    console.warn("[bots] cannot persist lastConnectedAt", (error as Error).name);
  }
}

function persistRecord(previous: BotRecord, next: BotRecord) {
  bots.set(next.botId, next);
  try {
    saveBots();
  } catch (error) {
    bots.set(previous.botId, previous);
    throw error;
  }
}

/** Telegram-style command list declared by the bot script; `[]` clears it. */
export function setBotCommands(
  botId: string,
  raw: unknown,
):
  | { ok: true; bot: BotPublic; commands: BotCommandInfo[] }
  | { ok: false; error: string } {
  ensureLoaded();
  const record = bots.get(String(botId || ""));
  if (!record) return { ok: false, error: "Бот не найден" };
  const commands = normalizeBotCommands(raw);
  if (commands === null) {
    return {
      ok: false,
      error: "Некорректный список команд: до 32 команд вида /name с описанием",
    };
  }
  const next: BotRecord = { ...record };
  if (commands.length) next.commands = commands;
  else delete next.commands;
  // The SDK re-declares its list after every reconnect — avoid idle disk writes.
  if (JSON.stringify(record.commands ?? []) === JSON.stringify(commands)) {
    return { ok: true, bot: publicBot(record), commands };
  }
  persistRecord(record, next);
  return { ok: true, bot: publicBot(next), commands };
}

export function setBotDescription(
  botId: string,
  raw: unknown,
): { ok: true; bot: BotPublic } | { ok: false; error: string } {
  ensureLoaded();
  const record = bots.get(String(botId || ""));
  if (!record) return { ok: false, error: "Бот не найден" };
  const description = sanitizeBotText(raw, 512);
  const next: BotRecord = { ...record };
  if (description) next.description = description;
  else delete next.description;
  persistRecord(record, next);
  return { ok: true, bot: publicBot(next) };
}

/** Keep the registry in sync after `updateProfile` changed the user name. */
export function setBotDisplayName(botId: string, displayName: string): BotPublic | null {
  ensureLoaded();
  const record = bots.get(String(botId || ""));
  if (!record) return null;
  const next: BotRecord = {
    ...record,
    displayName: sanitizeBotText(displayName, 32) || record.displayName,
  };
  persistRecord(record, next);
  return publicBot(next);
}

/** Description and commands for people/chat payloads; `null` for humans. */
export function botProfileMeta(
  userId: string,
): { description: string; commands: BotCommandInfo[] } | null {
  const record = findBot(userId);
  if (!record) return null;
  return { description: record.description || "", commands: record.commands ?? [] };
}

/**
 * Local admin secret. Written next to the other data files on first use so the
 * CLI and the running server agree without any extra configuration.
 * Set BOT_ADMIN_SECRET to manage bots over the network instead.
 */export function botAdminSecret() {
  const fromEnv = String(process.env.BOT_ADMIN_SECRET || "").trim();
  if (fromEnv.length >= 16) return fromEnv;
  if (existsSync(ADMIN_SECRET_FILE)) {
    const saved = readFileSync(ADMIN_SECRET_FILE, "utf8").trim();
    if (saved.length >= 16) return saved;
  }
  const secret = randomBytes(32).toString("hex");
  // Plain text, not JSON: the CLI reads the same file byte for byte.
  ensureDataDir();
  const tmp = `${ADMIN_SECRET_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmp, ADMIN_SECRET_FILE);
  } catch {
    writeFileSync(ADMIN_SECRET_FILE, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return secret;
}

export function verifyBotAdminSecret(value: unknown) {
  const provided = String(value || "");
  if (provided.length < 16) return false;
  const expected = botAdminSecret();
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}
