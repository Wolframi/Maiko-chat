/** Shared WebRTC ICE config — prefers local TURN when available. */

export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const FALLBACK_ICE: IceServerConfig[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19305" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

function isIpLiteral(host: string) {
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(":")
  );
}

function turnHostFromEnv() {
  const host = (process.env.NEXT_PUBLIC_TURN_HOST || "").trim();
  if (host) return host.replace(/^https?:\/\//, "").replace(/\/$/, "");
  try {
    const origin = (process.env.NEXT_PUBLIC_PUBLIC_ORIGIN || process.env.PUBLIC_ORIGIN || "").trim();
    if (origin) return new URL(origin).hostname;
  } catch {
    /* ignore */
  }
  return "";
}

/** Server-side ICE list (also used by /api/ice). */
export function buildIceServers(options?: {
  turnHost?: string;
  turnUser?: string;
  turnPass?: string;
}): IceServerConfig[] {
  const host = (options?.turnHost || turnHostFromEnv() || "").trim();
  // Credentials come only from the authenticated server API and expire shortly.
  const user = (options?.turnUser || "").trim();
  const pass = (options?.turnPass || "").trim();

  // Several STUN for faster candidate gathering and resilience.
  const servers: IceServerConfig[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19305" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];

  if (host && user && pass) {
    const turnUrls = [
      `turn:${host}:3478?transport=udp`,
      `turn:${host}:3478?transport=tcp`,
    ];
    // TLS relay only when the host is a domain whose certificate covers
    // 5349 (coturn tls-listening-port). Browsers skip it silently otherwise.
    if (!isIpLiteral(host)) {
      turnUrls.push(`turns:${host}:5349?transport=tcp`);
    }
    servers.push({
      urls: turnUrls,
      username: user,
      credential: pass,
    });
  }


  return servers.length ? servers : FALLBACK_ICE;
}

let cachedClientIce: RTCIceServer[] | null = null;
let clientIcePromise: Promise<RTCIceServer[]> | null = null;
let cachedClientIceAt = 0;
/** Refresh the ICE list occasionally — TURN config may change server-side. */
const CLIENT_ICE_TTL_MS = 2 * 60_000;
let cachedClientToken: string | null | undefined;

/** Browser: fetch expiring ICE credentials from API (falls back to STUN only). */
export async function getClientIceServers(token?: string | null): Promise<RTCIceServer[]> {
  if (token !== cachedClientToken) {
    clearClientIceCache();
    cachedClientToken = token;
  }
  if (cachedClientIce && Date.now() - cachedClientIceAt < CLIENT_ICE_TTL_MS) {
    return cachedClientIce;
  }
  if (cachedClientIce) {
    // Stale — drop so a fresh fetch happens now.
    cachedClientIce = null;
    clientIcePromise = null;
  }
  if (!clientIcePromise) {
    clientIcePromise = (async () => {
      try {
        const headers: Record<string, string> = {};
        if (token) headers["x-pulse-token"] = token;
        const res = await fetch("/api/ice", {
          headers,
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as { iceServers?: RTCIceServer[] };
          if (Array.isArray(data.iceServers) && data.iceServers.length) {
            if (cachedClientToken === token) {
              cachedClientIce = data.iceServers;
              cachedClientIceAt = Date.now();
            }
            return data.iceServers;
          }
        }
      } catch {
        /* fall through */
      }
      const built = buildIceServers() as RTCIceServer[];
      if (cachedClientToken === token) {
        cachedClientIce = built;
        cachedClientIceAt = Date.now();
      }
      return built;
    })();
  }
  return clientIcePromise;
}

export function clearClientIceCache() {
  cachedClientIce = null;
  clientIcePromise = null;
  cachedClientIceAt = 0;
  cachedClientToken = undefined;
}
