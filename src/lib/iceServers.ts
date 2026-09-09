/** Shared WebRTC ICE config — prefers local TURN when available. */

export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const FALLBACK_ICE: IceServerConfig[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

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
  const user = (options?.turnUser || process.env.TURN_USER || process.env.NEXT_PUBLIC_TURN_USER || "").trim();
  const pass = (options?.turnPass || process.env.TURN_PASS || process.env.NEXT_PUBLIC_TURN_PASS || "").trim();

  // Google STUN first — local STUN/TURN on :3478 only help when coturn is up.
  const servers: IceServerConfig[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];

  if (host && user && pass) {
    servers.push({
      urls: [
        `turn:${host}:3478?transport=udp`,
        `turn:${host}:3478?transport=tcp`,
      ],
      username: user,
      credential: pass,
    });
  }

  // Last-resort public TURN if local is not configured.
  if (!user || !pass || !host) {
    servers.push({
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:80?transport=tcp",
        "turn:openrelay.metered.ca:443",
        "turns:openrelay.metered.ca:443",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    });
  }

  return servers.length ? servers : FALLBACK_ICE;
}

let cachedClientIce: RTCIceServer[] | null = null;
let clientIcePromise: Promise<RTCIceServer[]> | null = null;

/** Browser: fetch signed ICE from API (falls back to public STUN/TURN). */
export async function getClientIceServers(token?: string | null): Promise<RTCIceServer[]> {
  if (cachedClientIce) return cachedClientIce;
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
            cachedClientIce = data.iceServers;
            return cachedClientIce;
          }
        }
      } catch {
        /* fall through */
      }
      const built = buildIceServers() as RTCIceServer[];
      cachedClientIce = built;
      return built;
    })();
  }
  return clientIcePromise;
}

export function clearClientIceCache() {
  cachedClientIce = null;
  clientIcePromise = null;
}
