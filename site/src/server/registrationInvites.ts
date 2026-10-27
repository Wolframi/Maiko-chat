import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const filename = path.join(process.cwd(), "data", "registration-invites.json");
type Member = { id: string; username: string; createdAt: number };
type Settings = { required: boolean; adminUserId: string | null; secret: string };
let settings: Settings | undefined;

function save(next: Settings) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temp, filename);
  settings = next;
}

/** Pin the existing account's immutable ID, never grant rights by a mutable nickname. */
export function initializeRegistrationInvites(members: Member[]) {
  if (settings) return;
  if (existsSync(filename)) {
    const parsed = JSON.parse(readFileSync(filename, "utf8")) as Settings;
    if (typeof parsed.required !== "boolean" || !/^[a-f0-9]{64}$/.test(parsed.secret)
      || !(parsed.adminUserId === null || typeof parsed.adminUserId === "string")) {
      throw new Error("Invalid registration invite settings");
    }
    settings = parsed;
  } else {
    save({ required: true, adminUserId: members.find(u => u.username.toLowerCase() === "artem")?.id ?? null,
      secret: randomBytes(32).toString("hex") });
  }
}

function config() {
  if (!settings) throw new Error("Registration invites are not initialized");
  return settings;
}

export function registrationPolicy() { return { required: config().required }; }

export function canManageRegistration(userId: string) { return config().adminUserId === userId; }

export function setRegistrationPolicy(userId: string, required: unknown) {
  if (!canManageRegistration(userId)) return { ok: false as const, error: "Нет доступа" };
  if (typeof required !== "boolean") return { ok: false as const, error: "Некорректная настройка" };
  save({ ...config(), required });
  return { ok: true as const, required };
}

/** Each member's window lasts exactly seven days, anchored to account creation. */
export function memberRegistrationInvite(member: Member, now = Date.now()) {
  const period = Math.floor((now - member.createdAt) / WEEK_MS);
  const raw = createHmac("sha256", config().secret)
    .update(`registration-week:${member.id}:${period}`).digest("hex").slice(0, 20).toUpperCase();
  return { code: raw.match(/.{4}/g)!.join("-"),
    expiresAt: member.createdAt + (period + 1) * WEEK_MS, serverTime: now };
}

export function registrationInviter(code: unknown, members: Member[], now = Date.now()) {
  if (typeof code !== "string" || code.length > 64) return null;
  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-F0-9]{20}$/.test(normalized)) return null;
  return members.find(member => memberRegistrationInvite(member, now).code.replace(/-/g, "") === normalized) ?? null;
}
