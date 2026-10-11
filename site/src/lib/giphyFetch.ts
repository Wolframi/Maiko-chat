import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupP } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

const GIPHY_API_HOST = "api.giphy.com";
const GIPHY_MEDIA_HOST = "media.giphy.com";
const AGENT_TTL_MS = 30 * 60_000;

let agent: Agent | null = null;
let agentAt = 0;

/** api.giphy.com Fastly VIPs time out from the VPS; media.giphy.com does not. */
async function giphyDispatcher() {
  if (agent && Date.now() - agentAt < AGENT_TTL_MS) return agent;
  const { address } = await dnsLookupP(GIPHY_MEDIA_HOST, { family: 4 });
  agent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (hostname === GIPHY_API_HOST) {
          if (options && options.all) {
            callback(null, [{ address, family: 4 }]);
            return;
          }
          callback(null, address, 4);
          return;
        }
        dnsLookup(hostname, options, callback);
      },
    },
  });
  agentAt = Date.now();
  return agent;
}

export async function fetchGiphyApi(
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  return (await undiciFetch(url, {
    headers: init.headers,
    signal: init.signal,
    dispatcher: await giphyDispatcher(),
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
}
