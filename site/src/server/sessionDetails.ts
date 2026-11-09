import { isIP } from "node:net";
import type { DeviceSession } from "../lib/deviceSessions";
import { isPublicPushAddress } from "./pushSecurity";

export type SessionContext = { ip: string; userAgent: string };

export function sessionDevice(userAgent = ""): Pick<DeviceSession, "browser" | "os" | "device"> {
  const ua = userAgent.slice(0, 1024);
  const os = /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iPod/i.test(ua) ? "iOS"
    : /Windows/i.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/i.test(ua) ? "macOS"
    : /Linux/i.test(ua) ? "Linux" : "Неизвестная ОС";
  const browser = /Electron|Maiko/i.test(ua) ? "Майко Desktop"
    : /Edg(?:e|A|iOS)?\//i.test(ua) ? "Microsoft Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Firefox\/|FxiOS\//i.test(ua) ? "Firefox"
    : /SamsungBrowser\//i.test(ua) ? "Samsung Internet"
    : /Chrome\/|CriOS\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari" : "Неизвестное приложение";
  const device = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? "tablet"
    : /Mobile|iPhone|iPod/i.test(ua) ? "mobile"
    : /Windows|Macintosh|Linux|Electron/i.test(ua) ? "desktop" : "unknown";
  return { browser, os, device };
}

export function sessionIp(value: string) {
  const ip = value.replace(/^::ffff:/i, "").trim();
  return isIP(ip) ? ip : "";
}

function cleanPlace(value: unknown) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) : "";
}

// Only the IP is sent to the provider; account data and session tokens stay here.
// Cache successful and failed lookups, coalesce concurrent requests and bound memory.
export function createSessionLocator(request: typeof fetch = fetch) {
  const cache = new Map<string, { until: number; result: Promise<string | null> }>();
  return async (address: string): Promise<string | null> => {
    const ip = sessionIp(address);
    if (!ip) return null;
    if (!isPublicPushAddress(ip)) return "Локальная или частная сеть";
    if (process.env.SESSION_GEOLOCATION === "0") return null;
    const saved = cache.get(ip);
    if (saved && saved.until > Date.now()) return saved.result;
    const result = (async () => {
      try {
        const response = await request(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country&lang=ru`, {
          signal: AbortSignal.timeout(1500), redirect: "error",
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (data?.success !== true) return null;
        const parts = [data.city, data.region, data.country].map(cleanPlace).filter(Boolean);
        return [...new Set(parts)].join(", ") || null;
      } catch { return null; }
    })();
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(ip, { until: Date.now() + 24 * 60 * 60_000, result });
    return result;
  };
}

export const locateSession = createSessionLocator();
