import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import webpush from "web-push";

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

export async function sendPushToUser(userId: string, payload: PushPayload) {
  const data = ensureStore();
  const list = data.byUser[userId] || [];
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
