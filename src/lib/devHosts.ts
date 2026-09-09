import os from "node:os";

function extraDevHostsFromEnv() {
  const hosts: string[] = [];
  const raw = [
    process.env.ALLOWED_DEV_ORIGINS || "",
    process.env.PUBLIC_ORIGIN || "",
  ].join(",");
  for (const part of raw.split(/[,\s]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const host = trimmed.includes("://")
        ? new URL(trimmed).hostname
        : trimmed.replace(/\/$/, "").split(":")[0];
      if (host) hosts.push(host);
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

/** Windows sets HOSTNAME to the PC name — that is not a bind address. */
export function isBindAddress(value: string) {
  return /^(0\.0\.0\.0|::|\[::\]|localhost|127\.0\.0\.1)$/i.test(value)
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

export function listenHostname() {
  const raw = (
    process.env.PULSE_HOST ||
    process.env.HOST ||
    process.env.HOSTNAME ||
    ""
  ).trim();
  if (isBindAddress(raw)) {
    if (raw === "::" || raw === "[::]") return "::";
    return raw;
  }
  return "0.0.0.0";
}

export function lanIPv4Addresses() {
  const ips: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      const family = String(addr.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (addr.internal) continue;
      ips.push(addr.address);
    }
  }
  return ips;
}

export function lanDevHosts() {
  return [...new Set([...lanIPv4Addresses(), ...extraDevHostsFromEnv()])];
}

export function isDevAccessibleHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return true;
  }
  if (host.endsWith(".local") || host.endsWith(".trycloudflare.com")) {
    return true;
  }
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  return lanDevHosts().some((item) => item.toLowerCase() === host);
}
