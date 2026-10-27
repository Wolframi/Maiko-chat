import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GroupInviteCode } from "../lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const TIME_ZONE_OFFSET_MS = 5 * 60 * 60 * 1000; // Asia/Yekaterinburg
const WEEK_START_MS = Date.UTC(1970, 0, 5) - TIME_ZONE_OFFSET_MS; // Monday 00:00
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let cachedSecret: string | undefined;

function inviteSecret() {
  if (cachedSecret) return cachedSecret;
  const directory = path.join(process.cwd(), "data");
  const filename = path.join(directory, "group-invite-secret.txt");
  mkdirSync(directory, { recursive: true });
  try {
    cachedSecret = readFileSync(filename, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      writeFileSync(filename, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    }
    cachedSecret = readFileSync(filename, "utf8").trim();
  }
  if (!/^[a-f0-9]{64}$/.test(cachedSecret)) {
    cachedSecret = undefined;
    throw new Error("Invalid group invite signing secret");
  }
  return cachedSecret;
}

export function normalizeGroupInviteCode(value: string) {
  return value.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** A calendar-week code, rotating every Monday at 00:00 in Yekaterinburg. */
export function weeklyGroupInviteCode(
  groupId: string,
  now = Date.now(),
  secret = inviteSecret(),
): GroupInviteCode {
  const week = Math.floor((now - WEEK_START_MS) / WEEK_MS);
  const digest = createHmac("sha256", secret).update(`group-week:${groupId}:${week}`).digest();
  const raw = Array.from(digest.subarray(0, 12), byte => ALPHABET[byte & 31]).join("");
  return {
    code: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`,
    expiresAt: WEEK_START_MS + (week + 1) * WEEK_MS,
    serverTime: now,
  };
}
