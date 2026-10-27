import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { rateLimit } from "./rateLimit";

export function clientAddress(req: IncomingMessage) {
  const peer = req.socket.remoteAddress || "unknown";
  if (process.env.TRUST_PROXY === "1" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) {
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (isIP(real)) return real;
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").at(-1)?.trim() || "";
    if (isIP(forwarded)) return forwarded;
  }
  return peer.replace(/^::ffff:/, "");
}

export function allowRegistration(address: string) {
  return rateLimit(`register-minute:${address}`, 3, 60_000)
    && rateLimit(`register-hour:${address}`, 10, 60 * 60_000)
    && rateLimit("register-global", 30, 60 * 60_000);
}
