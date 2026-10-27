import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { isAllowedPushEndpoint, validPushKeys, pushAgent } from "./pushSecurity";

type PushSub = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

type Stored = {
  vapid: { publicKey: string; privateKey: string };
  /** userId -> subscriptions */
  byUser: Record<string, PushSub[]>;
};

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "push.json");

let store: Stored | null = null;

function ensureStore(): Stored {
  if (store) return store;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(STORE_FILE)) {
    try {
      store = JSON.parse(readFileSync(STORE_FILE, "utf8")) as Stored;
      if (store?.vapid?.publicKey && store?.vapid?.privateKey) {
        webpush.setVapidDetails(
          "mailto:pulse@localhost",
          store.vapid.publicKey,
          store.vapid.privateKey,
        );
        store.byUser = store.byUser || {};
        return store;
      }
    } catch {
      /* regenerate */
    }
  }
  const vapid = webpush.generateVAPIDKeys();
  store = { vapid, byUser: {} };
  persist();
  webpush.setVapidDetails(
    "mailto:pulse@localhost",
    vapid.publicKey,
    vapid.privateKey,
  );
  return store;
}

function persist() {
  if (!store) return;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(store), "utf8");
  } catch {
    /* ignore */
  }
}

export function getVapidPublicKey() {
  return ensureStore().vapid.publicKey;
}

export function hasPushSubscription(userId: string) {
  const list = ensureStore().byUser[userId];
  return Boolean(list && list.length);
}

export function savePushSubscription(userId: string, sub: PushSub) {
  if (!isAllowedPushEndpoint(sub.endpoint) || !validPushKeys(sub.keys)) {
    throw new Error("Invalid push subscription");
  }
  const data = ensureStore();
  const list = data.byUser[userId] || [];
  const next = list.filter((item) => item.endpoint !== sub.endpoint);
  next.push(sub);
  // Keep at most 5 devices per user
  data.byUser[userId] = next.slice(-5);
  persist();
}

export function removePushSubscription(userId: string, endpoint: string) {
  const data = ensureStore();
  const list = data.byUser[userId] || [];
  data.byUser[userId] = list.filter((item) => item.endpoint !== endpoint);
  persist();
}

export type PushPayload = {
  title: string;
  body: string;
  chatId?: string;
  callId?: string;
  kind?: "call" | "message";
  tag?: string;
};

const sending = new Set<string>();

export async function sendPushToUser(userId: string, payload: PushPayload) {
  // Coalesce notifications for busy users and bound outbound work globally.
  if (sending.size >= 8 || sending.has(userId)) return { sent: 0 };
  sending.add(userId);
  try { return await deliverPush(userId, payload); }
  finally { sending.delete(userId); }
}

async function deliverPush(userId: string, payload: PushPayload) {
  const data = ensureStore();
  // Revalidate persisted subscriptions too: old stores may contain unsafe URLs.
  const list = (data.byUser[userId] || []).filter(sub => isAllowedPushEndpoint(sub.endpoint) && validPushKeys(sub.keys)).slice(-5);
  if (!list.length) return { sent: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  const keep: PushSub[] = [];

  await Promise.all(
    list.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, {
          TTL: payload.kind === "call" ? 60 : 300,
          urgency: payload.kind === "call" ? "high" : "normal",
          agent: pushAgent,
          timeout: 5000,
        });
        keep.push(sub);
        sent += 1;
      } catch (error) {
        const status = Number(
          (error as { statusCode?: number })?.statusCode || 0,
        );
        // Gone / expired — drop
        if (status === 404 || status === 410) return;
        keep.push(sub);
      }
    }),
  );

  data.byUser[userId] = keep;
  persist();
  return { sent };
}
