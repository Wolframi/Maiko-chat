import { createHash, createHmac, randomBytes } from "node:crypto";

export const TURN_TTL_SECONDS = 10 * 60;

export function issueTurnCredentials(secret: string, userId: string, sessionToken: string, now = Date.now()) {
  if (secret.length < 32) throw new Error("TURN_AUTH_SECRET must contain at least 32 characters");
  const expiresAt = Math.floor(now / 1000) + TURN_TTL_SECONDS;
  const identity = createHash("sha256").update(`${userId}:${sessionToken}`).digest("hex").slice(0, 24);
  const username = `${expiresAt}:${identity}:${randomBytes(8).toString("hex")}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, expiresAt };
}
