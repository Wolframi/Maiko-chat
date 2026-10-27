import { lookup } from "node:dns";
import { Agent } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

export function isPublicPushAddress(address: string) {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  // Only global IPv6 unicast; excludes mapped IPv4, loopback, link-local and ULA.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
    && !blocked.check(address, "ipv6");
}

export function isAllowedPushEndpoint(endpoint: string) {
  if (typeof endpoint !== "string" || endpoint.length > 4096) return false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    return url.protocol === "https:" && !url.username && !url.password
      && !url.hash && (!url.port || url.port === "443")
      && (host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com"
        || host === "web.push.apple.com"
        || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host));
  } catch { return false; }
}

// Validate the address used by the actual connection, preventing DNS rebinding.
export function createPushLookup(resolve: typeof lookup = lookup): LookupFunction {
  return (hostname, options, callback) => {
    if (!isAllowedPushEndpoint(`https://${hostname}/`)) {
      callback(new Error("Push provider is not allowed"), "", 0);
      return;
    }
    resolve(hostname, { all: true, family: options.family }, (error, addresses) => {
      if (error || !addresses.length || addresses.some(({ address }) => !isPublicPushAddress(address))) {
        callback(error || new Error("Push provider resolved to a non-public address"), "", 0);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export const pushLookup = createPushLookup();

export const pushAgent = new Agent({ lookup: pushLookup, maxSockets: 8 });

export function validPushKeys(keys?: { p256dh: string; auth: string }) {
  if (!keys || !/^[A-Za-z0-9_-]{87}=?$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(keys.auth)) return false;
  const publicKey = Buffer.from(keys.p256dh, "base64url");
  return publicKey.length === 65 && publicKey[0] === 4 && Buffer.from(keys.auth, "base64url").length === 16;
}
