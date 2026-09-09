import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createServer,
  request as httpRequest,
} from "node:http";
import type { Duplex } from "node:stream";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { parse } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import next from "next";
import { Server, type Socket } from "socket.io";
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";
import {
  bindSocketAuth,
  getSocketAccount,
  getUserById,
  listUsers,
  loginUser,
  logoutToken,
  registerUser,
  restoreSession,
  touchLastSeen,
  unbindSocketAuth,
  updateProfile,
  onSessionRevoked,
  socketIdsForToken,
  ensureDemoUsers,
  type AuthAccount,
} from "./src/server/auth";
import {
  canAccessChat,
  createGroup,
  createVoiceChannel,
  deleteVoiceChannel,
  addGroupMember,
  dmTitleForViewer,
  ensureVoiceChannels,
  findVoiceChannel,
  getChat,
  groupVisibility,
  joinPublicGroup,
  listChatsForUser,
  listMemberProfiles,
  openDm,
  peerIdForViewer,
  searchPublicGroups,
  updateGroupAvatar,
  updateGroupProfile,
  updateGroupVisibility,
  deleteGroup,
  leaveGroup,
  isProtectedChat,
  type ChatMeta,
} from "./src/server/chats";
import {
  handleUpload,
  tryServeUpload,
  uploadPathFromUrl,
  mimeFromName,
  isBlockedUpload,
  isValidStoredAvatar,
  uploadOwnedBy,
  signUploadUrl,
  signAvatarUrl,
  bareUploadUrl,
} from "./src/server/uploads";
import { handleRingtones } from "./src/server/ringtones";
import { rateLimit } from "./src/server/rateLimit";
import { buildIceServers } from "./src/lib/iceServers";
import {
  getVapidPublicKey,
  hasPushSubscription,
  removePushSubscription,
  savePushSubscription,
  sendPushToUser,
} from "./src/server/push";
import {
  albumPreviewText,
  attachmentPreviewText,
  isAudioAttachment,
  isImageAttachment,
  isVideoAttachment,
  messageAttachments,
} from "./src/lib/files";
import type { RoomMediaItem } from "./src/lib/types";
import {
  isDevAccessibleHost,
  lanIPv4Addresses,
  listenHostname,
} from "./src/lib/devHosts";

const dev = process.env.NODE_ENV !== "production";
const hostname = listenHostname();
const port = Number(process.env.PORT) || 3000;

function loadTurnSecrets() {
  try {
    const dir = process.cwd();
    const user = readFileSync(path.join(dir, ".turn-user"), "utf8")
      .replace(/\r/g, "")
      .trim();
    const pass = readFileSync(path.join(dir, ".turn-pass"), "utf8")
      .replace(/\r/g, "")
      .trim();
    if (user && pass) return { user, pass };
  } catch {
    /* optional */
  }
  return {
    user: (process.env.TURN_USER || "").trim(),
    pass: (process.env.TURN_PASS || "").trim(),
  };
}

function readOptionalSecret(filename: string, envName: string) {
  try {
    const value = readFileSync(path.join(process.cwd(), filename), "utf8")
      .replace(/\r/g, "")
      .trim();
    if (value) return value;
  } catch {
    /* optional */
  }
  return String(process.env[envName] || "").trim();
}

function isLiveKitCloudUrl(url: string) {
  try {
    const host = new URL(url.replace(/^ws/i, "http")).hostname;
    return /(^|\.)livekit\.cloud$/i.test(host);
  } catch {
    return /livekit\.cloud/i.test(url);
  }
}

/** Self-hosted LiveKit on this VM (`livekit-server --dev`). Never LiveKit Cloud. */
const LOCAL_LIVEKIT = {
  url: "ws://127.0.0.1:7880",
  apiKey: "devkey",
  apiSecret: "secret",
};

function loadLiveKitConfig() {
  const configured = {
    url: readOptionalSecret(".livekit-url", "LIVEKIT_URL"),
    apiKey: readOptionalSecret(".livekit-api-key", "LIVEKIT_API_KEY"),
    apiSecret: readOptionalSecret(
      ".livekit-api-secret",
      "LIVEKIT_API_SECRET",
    ),
  };
  if (configured.url && isLiveKitCloudUrl(configured.url)) {
    console.warn("[livekit] Cloud URL ignored; using self-hosted SFU on this VM");
    configured.url = "";
  }
  if (configured.apiKey && configured.apiSecret) {
    return {
      url: configured.url || LOCAL_LIVEKIT.url,
      apiKey: configured.apiKey,
      apiSecret: configured.apiSecret,
    };
  }
  // Group channels always use the LiveKit on this VM (docker --dev locally,
  // systemd livekit on the VPS). Never return empty keys — that left clients
  // "in channel" with no SFU in production when .livekit-* files were missing.
  return LOCAL_LIVEKIT;
}

function liveKitRoomName(channelId: string) {
  return `pulse-${createHash("sha256").update(channelId).digest("hex").slice(0, 32)}`;
}

function liveKitUpstream() {
  const raw = loadLiveKitConfig().url.replace(/^ws/i, "http");
  try {
    const url = new URL(raw);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return url;
    }
  } catch {
    /* fall through */
  }
  return new URL("http://127.0.0.1:7880");
}

/** Browser-facing SFU URL: same origin so HTTPS pages are not sent to ws://127.0.0.1. */
function publicLiveKitUrl(req: IncomingMessage) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  const forwarded = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const proto = forwarded || (dev ? "http" : "https");
  if (!host) return loadLiveKitConfig().url;
  return `${proto === "https" ? "wss" : "ws"}://${host}/livekit`;
}

function liveKitProxyPath(url: string) {
  const stripped = url.replace(/^\/livekit\/?/, "/") || "/";
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function proxyLiveKitHttp(req: IncomingMessage, res: ServerResponse) {
  const upstream = liveKitUpstream();
  const headers = { ...req.headers, host: upstream.host };
  const proxyReq = httpRequest(
    {
      hostname: upstream.hostname,
      port: Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 7880),
      path: liveKitProxyPath(req.url || "/"),
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (res.headersSent) return;
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "SFU недоступен" }));
  });
  req.pipe(proxyReq);
}

function proxyLiveKitUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  const upstream = liveKitUpstream();
  const headers = {
    ...req.headers,
    host: upstream.host,
    connection: "Upgrade",
    upgrade: "websocket",
  };
  const proxyReq = httpRequest({
    hostname: upstream.hostname,
    port: Number(upstream.port) || 7880,
    path: liveKitProxyPath(req.url || "/"),
    method: "GET",
    headers,
  });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value == null) continue;
      lines.push(
        `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
      );
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    proxyReq.destroy();
  });
  if (head.length) proxyReq.write(head);
  proxyReq.end();
}

function liveKitRoomService() {
  const config = loadLiveKitConfig();
  if (!config.apiKey || !config.apiSecret) return null;
  const httpUrl = liveKitUpstream().origin;
  return new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);
}

async function removeLiveKitParticipant(channelId: string, userId: string) {
  const service = liveKitRoomService();
  if (!service) return;
  try {
    await service.removeParticipant(liveKitRoomName(channelId), userId);
  } catch {
    // The room or participant may already have disappeared.
  }
}

async function deleteLiveKitRoom(channelId: string) {
  const service = liveKitRoomService();
  if (!service) return;
  try {
    await service.deleteRoom(liveKitRoomName(channelId));
  } catch {
    // Deleting an already-empty/non-existent room is harmless.
  }
}
const publicOrigin = (process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "");

// Opt-in only: set SEED_DEMO=1 to create demo logins for try-out deploys.
if (process.env.SEED_DEMO === "1") {
  ensureDemoUsers();
}

type ReplyPreview = {
  id: string;
  author: string;
  text: string;
};

type MessageReaction = {
  emoji: string;
  userIds: string[];
};

type ChatMessage = {
  id: string;
  room: string;
  author: string;
  authorId?: string;
  text: string;
  createdAt: number;
  editedAt?: number;
  pinned?: boolean;
  kind?: "text" | "system" | "file" | "call" | "invite";
  file?: {
    url: string;
    name: string;
    size: number;
    mime: string;
  };
  files?: {
    url: string;
    name: string;
    size: number;
    mime: string;
  }[];
  replyTo?: ReplyPreview;
  forwardedFrom?: {
    author: string;
    text?: string;
  };
  invite?: {
    groupId: string;
    groupTitle: string;
    status: "pending" | "accepted" | "declined" | "expired";
  };
  reactions?: MessageReaction[];
};

function isAllowedReaction(emoji: string) {
  const value = String(emoji || "").trim();
  if (!value || value.length > 16) return false;
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  // Keep reactions to a single visible cluster (emoji / short symbol).
  if ([...value].length > 4) return false;
  return true;
}

type PresenceUser = {
  userId: string;
  name: string;
  room: string | null;
};

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const chatMessages = new Map<string, ChatMessage[]>();
const usersBySocket = new Map<string, PresenceUser>();
type CallRecord = {
  callId: string;
  callerId: string;
  calleeId: string;
  mode: "audio" | "video";
  chatId: string;
  status: "ringing" | "active";
  createdAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const callsById = new Map<string, CallRecord>();
const callByUser = new Map<string, string>();
const callDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RING_TIMEOUT_MS = 45_000;
const CALL_RECONNECT_GRACE_MS = 25_000;
const APP_BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CALL_SIGNAL_MAX_JSON = 64 * 1024;
const CALL_LOG_RE =
  /^(Звонок без ответа|(Видеозвонок|Звонок) завершён( · \d{1,3}:\d{2})?)$/;

type VoiceMember = {
  userId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  cameraOff: boolean;
  sharingScreen: boolean;
  mediaRevision: number;
  avatarUrl?: string;
  socketId: string;
};

/** channelId -> userId -> member */
const voiceByChannel = new Map<string, Map<string, VoiceMember>>();
/** userId -> channelId */
const voiceByUser = new Map<string, string>();
/** socketId -> channelId (so multi-tab doesn't strand presence) */
const voiceBySocket = new Map<string, string>();
const voiceDisconnectTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const VOICE_RECONNECT_GRACE_MS = 25_000;
/** channelId -> topology epoch (bumped if topology ever changes) */
const voiceTopologyEpoch = new Map<string, number>();

type VoiceTopology = "p2p" | "sfu";

function voiceChannelSize(channelId: string) {
  return voiceByChannel.get(channelId)?.size || 0;
}

function voiceTopologyForSize(_size: number): VoiceTopology {
  // Group channels: always SFU. Participant count does not matter.
  // DM calls never use this — they are P2P in `useCall`.
  return "sfu";
}

function voiceTopologyInfo(channelId: string) {
  const size = voiceChannelSize(channelId);
  const topology = voiceTopologyForSize(size);
  const epoch = voiceTopologyEpoch.get(channelId) || 0;
  return { topology, topologyEpoch: epoch, size };
}

function maybeBumpVoiceTopology(channelId: string, previousSize: number) {
  const nextSize = voiceChannelSize(channelId);
  const prev = voiceTopologyForSize(previousSize);
  const next = voiceTopologyForSize(nextSize);
  if (nextSize === 0) {
    voiceTopologyEpoch.delete(channelId);
    return voiceTopologyInfo(channelId);
  }
  if (!voiceTopologyEpoch.has(channelId)) {
    voiceTopologyEpoch.set(channelId, 1);
  } else if (prev !== next) {
    voiceTopologyEpoch.set(
      channelId,
      (voiceTopologyEpoch.get(channelId) || 1) + 1,
    );
  }
  return voiceTopologyInfo(channelId);
}

const lastReadByUser = new Map<string, Map<string, number>>();
const pinnedByUser = new Map<string, Set<string>>();
/** Allows call:log shortly after a real call involving the user. */
const callLogAllow = new Map<string, number>();
/** clientId -> server message id (idempotency, short-lived). */
const clientMsgIds = new Map<string, { id: string; expires: number }>();

const DATA_DIR = path.join(process.cwd(), "data");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const READS_FILE = path.join(DATA_DIR, "reads.json");
const PINS_FILE = path.join(DATA_DIR, "pins.json");
const LIVE_MEDIA_FILE = path.join(DATA_DIR, "live-media.json");
const LIVE_MEDIA_MAX_AGE_MS = 10 * 60_000;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** Atomic replace — avoids torn JSON if the process dies mid-write. */
function atomicWriteJson(filePath: string, payload: unknown) {
  ensureDataDir();
  const body = JSON.stringify(payload);
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, body, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, body, "utf8");
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Coalesce rapid persist calls onto one write of the latest in-memory state.
 * A promise chain guarantees writes never overlap (safe under 100 msg/s bursts).
 */
type Persister = (() => void) & { idle: () => Promise<void> };

function createPersister(write: () => void): Persister {
  let dirty = false;
  let chain: Promise<void> = Promise.resolve();

  const flushOnce = () =>
    new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          write();
        } catch (error) {
          console.error("[persist]", error);
        }
        resolve();
      });
    });

  const schedule = (() => {
    dirty = true;
    chain = chain.then(async () => {
      // Drain all dirties that arrived while the previous write ran.
      while (dirty) {
        dirty = false;
        await flushOnce();
      }
    });
  }) as Persister;
  schedule.idle = () => chain;
  return schedule;
}

function writeMessagesSnapshot() {
  const payload: Record<string, ChatMessage[]> = {};
  for (const [chatId, list] of chatMessages) {
    payload[chatId] = list.map((message) => {
      if (!message.file?.url) return message;
      return {
        ...message,
        file: { ...message.file, url: bareUploadUrl(message.file.url) },
      };
    });
  }
  atomicWriteJson(MESSAGES_FILE, payload);
}

function writeReadsSnapshot() {
  const payload: Record<string, Record<string, number>> = {};
  for (const [userId, map] of lastReadByUser) {
    payload[userId] = Object.fromEntries(map);
  }
  atomicWriteJson(READS_FILE, payload);
}

function writePinsSnapshot() {
  const payload: Record<string, string[]> = {};
  for (const [userId, set] of pinnedByUser) {
    payload[userId] = [...set];
  }
  atomicWriteJson(PINS_FILE, payload);
}

function writeLiveMediaSnapshot() {
  const calls = [...callsById.values()].map((call) => ({
    callId: call.callId,
    callerId: call.callerId,
    calleeId: call.calleeId,
    mode: call.mode,
    chatId: call.chatId,
    status: call.status,
    createdAt: call.createdAt,
  }));
  const voice: {
    channelId: string;
    members: Omit<VoiceMember, "socketId">[];
  }[] = [];
  for (const [channelId, room] of voiceByChannel) {
    voice.push({
      channelId,
      members: [...room.values()].map(({ socketId: _socketId, ...member }) => member),
    });
  }
  atomicWriteJson(LIVE_MEDIA_FILE, { at: Date.now(), calls, voice });
}

const persistMessages = createPersister(writeMessagesSnapshot);
const persistReads = createPersister(writeReadsSnapshot);
const persistPins = createPersister(writePinsSnapshot);
const persistLiveMedia = createPersister(writeLiveMediaSnapshot);

function flushAllPersists() {
  writeMessagesSnapshot();
  writeReadsSnapshot();
  writePinsSnapshot();
  writeLiveMediaSnapshot();
}

function loadPersistedState() {
  try {
    if (existsSync(MESSAGES_FILE)) {
      const raw = JSON.parse(readFileSync(MESSAGES_FILE, "utf8")) as Record<
        string,
        ChatMessage[]
      >;
      for (const [chatId, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        chatMessages.set(
          chatId,
          list.map((message) => {
            if (!message.file?.url) return message;
            return {
              ...message,
              file: {
                ...message.file,
                url: bareUploadUrl(message.file.url),
              },
            };
          }),
        );
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(READS_FILE)) {
      const raw = JSON.parse(readFileSync(READS_FILE, "utf8")) as Record<
        string,
        Record<string, number>
      >;
      for (const [userId, map] of Object.entries(raw)) {
        lastReadByUser.set(userId, new Map(Object.entries(map)));
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(PINS_FILE)) {
      const raw = JSON.parse(readFileSync(PINS_FILE, "utf8")) as Record<
        string,
        string[]
      >;
      for (const [userId, list] of Object.entries(raw)) {
        pinnedByUser.set(userId, new Set(list));
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (!existsSync(LIVE_MEDIA_FILE)) return;
    const raw = JSON.parse(readFileSync(LIVE_MEDIA_FILE, "utf8")) as {
      at?: number;
      calls?: Array<Omit<CallRecord, "timer">>;
      voice?: Array<{
        channelId?: string;
        members?: Array<Omit<VoiceMember, "socketId">>;
      }>;
    };
    if (!raw?.at || Date.now() - raw.at > LIVE_MEDIA_MAX_AGE_MS) {
      try {
        unlinkSync(LIVE_MEDIA_FILE);
      } catch {
        /* ignore */
      }
      return;
    }
    if (Array.isArray(raw.calls)) {
      for (const item of raw.calls) {
        if (!item?.callId || !item.callerId || !item.calleeId || !item.chatId) {
          continue;
        }
        if (item.status === "ringing" && Date.now() - item.createdAt > RING_TIMEOUT_MS) {
          continue;
        }
        const status = item.status === "ringing" ? "ringing" : "active";
        callsById.set(item.callId, {
          callId: item.callId,
          callerId: item.callerId,
          calleeId: item.calleeId,
          mode: item.mode === "video" ? "video" : "audio",
          chatId: item.chatId,
          status,
          createdAt: Number(item.createdAt) || Date.now(),
          timer: null,
        });
        callByUser.set(item.callerId, item.callId);
        callByUser.set(item.calleeId, item.callId);
      }
      setTimeout(() => {
        for (const call of [...callsById.values()]) {
          releaseZombieCall(call);
        }
      }, 25_000);
    }
    if (Array.isArray(raw.voice)) {
      for (const room of raw.voice) {
        const channelId = String(room?.channelId || "");
        if (!channelId || !Array.isArray(room.members) || !room.members.length) {
          continue;
        }
        if (!findVoiceChannel(channelId)) continue;
        const members = voiceByChannel.get(channelId) || new Map();
        for (const member of room.members) {
          if (!member?.userId) continue;
          members.set(member.userId, {
            userId: member.userId,
            name: String(member.name || "Pulse"),
            muted: Boolean(member.muted),
            deafened: Boolean(member.deafened),
            speaking: false,
            cameraOff: member.cameraOff !== false,
            sharingScreen: Boolean(member.sharingScreen),
            mediaRevision: Number(member.mediaRevision) || 0,
            avatarUrl: member.avatarUrl,
            socketId: "",
          });
          voiceByUser.set(member.userId, channelId);
        }
        if (members.size) voiceByChannel.set(channelId, members);
      }
    }
    try {
      unlinkSync(LIVE_MEDIA_FILE);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

loadPersistedState();

setInterval(() => {
  if (callsById.size || voiceByChannel.size) persistLiveMedia();
}, 20_000).unref();

function allowCallLog(userId: string, chatId: string) {
  callLogAllow.set(`${userId}:${chatId}`, Date.now() + 90_000);
}

function canCallLog(userId: string, chatId: string) {
  const key = `${userId}:${chatId}`;
  const until = callLogAllow.get(key) || 0;
  if (until < Date.now()) {
    callLogAllow.delete(key);
    return false;
  }
  return true;
}

function resolveClientMessageId(
  userId: string,
  clientIdRaw: string,
  findExisting: (id: string) => ChatMessage | undefined,
) {
  const clientId = String(clientIdRaw || "").slice(0, 80);
  const now = Date.now();
  if (!clientId || !/^[a-zA-Z0-9_-]+$/.test(clientId)) {
    return { id: randomUUID(), existing: undefined as ChatMessage | undefined };
  }
  const key = `${userId}:${clientId}`;
  const hit = clientMsgIds.get(key);
  if (hit && hit.expires > now) {
    const existing = findExisting(hit.id);
    if (existing) return { id: hit.id, existing };
  }
  const id = randomUUID();
  clientMsgIds.set(key, { id, expires: now + 10 * 60_000 });
  if (clientMsgIds.size > 5000) {
    for (const [k, v] of clientMsgIds) {
      if (v.expires <= now) clientMsgIds.delete(k);
    }
  }
  return { id, existing: undefined as ChatMessage | undefined };
}

function isPinned(userId: string, chatId: string) {
  return pinnedByUser.get(userId)?.has(chatId) ?? false;
}

function togglePinned(userId: string, chatId: string) {
  if (!pinnedByUser.has(userId)) pinnedByUser.set(userId, new Set());
  const set = pinnedByUser.get(userId)!;
  if (set.has(chatId)) set.delete(chatId);
  else set.add(chatId);
  persistPins();
  return set.has(chatId);
}

function toggleReaction(
  message: ChatMessage,
  userId: string,
  emoji: string,
) {
  const current = message.reactions || [];
  const already = current.some(
    (item) => item.emoji === emoji && item.userIds.includes(userId),
  );

  let next = current
    .map((item) => ({
      emoji: item.emoji,
      userIds: item.userIds.filter((id) => id !== userId),
    }))
    .filter((item) => item.userIds.length > 0);

  if (!already) {
    const slot = next.find((item) => item.emoji === emoji);
    if (slot) slot.userIds.push(userId);
    else next = [...next, { emoji, userIds: [userId] }];
  }

  message.reactions = next;
  return message;
}

function markChatRead(userId: string, chatId: string) {
  if (!lastReadByUser.has(userId)) {
    lastReadByUser.set(userId, new Map());
  }
  lastReadByUser.get(userId)!.set(chatId, Date.now());
  persistReads();
}

function unreadCountFor(chatId: string, viewerId: string) {
  const since = lastReadByUser.get(viewerId)?.get(chatId) ?? 0;
  return messagesFor(chatId).filter(
    (message) =>
      message.kind !== "system" &&
      message.createdAt > since &&
      message.authorId !== viewerId,
  ).length;
}

function resolveReply(
  chatId: string,
  replyToId?: string,
): ReplyPreview | undefined {
  if (!replyToId) return undefined;
  const source = messagesFor(chatId).find((item) => item.id === replyToId);
  if (!source || source.kind === "system") return undefined;
  const text =
    source.kind === "file"
      ? `Файл: ${source.file?.name || source.text}`
      : source.text;
  return {
    id: source.id,
    author: source.author,
    text: text.slice(0, 140),
  };
}

function clearCall(callId: string) {
  const call = callsById.get(callId);
  if (!call) return;
  if (call.timer) clearTimeout(call.timer);
  callsById.delete(callId);
  if (callByUser.get(call.callerId) === callId) callByUser.delete(call.callerId);
  if (callByUser.get(call.calleeId) === callId) callByUser.delete(call.calleeId);
  persistLiveMedia();
}

function peerIdOfCall(call: CallRecord, userId: string) {
  return call.callerId === userId ? call.calleeId : call.callerId;
}

function cancelCallDisconnectTimer(userId: string) {
  const timer = callDisconnectTimers.get(userId);
  if (!timer) return;
  clearTimeout(timer);
  callDisconnectTimers.delete(userId);
}

/** Drop one participant. Ringing calls end for both. Active calls keep the other person. */
function leaveCallParticipant(call: CallRecord, userId: string) {
  cancelCallDisconnectTimer(userId);
  const peerId = peerIdOfCall(call, userId);
  if (call.status === "ringing") {
    clearCall(call.callId);
    return peerId;
  }
  if (callByUser.get(userId) === call.callId) callByUser.delete(userId);
  const peerStillIn = callByUser.get(peerId) === call.callId;
  if (!peerStillIn) {
    clearCall(call.callId);
    return null;
  }
  return peerId;
}

function isCallBusy(userId: string) {
  return callByUser.has(userId);
}

function userIsConnected(userId: string) {
  return socketsForUser(userId).length > 0;
}

/** Drop an active call that nobody is actually connected to. */
function releaseZombieCall(call: CallRecord) {
  if (call.status === "ringing") return false;
  if (userIsConnected(call.callerId) || userIsConnected(call.calleeId)) {
    return false;
  }
  clearCall(call.callId);
  return true;
}

function releaseBusyUserIfZombie(userId: string) {
  const callId = callByUser.get(userId);
  if (!callId) return;
  const call = callsById.get(callId);
  if (!call) {
    callByUser.delete(userId);
    persistLiveMedia();
    return;
  }
  if (call.status === "ringing") return;
  if (!userIsConnected(peerIdOfCall(call, userId))) {
    clearCall(call.callId);
  }
}

function getCallForUsers(a: string, b: string) {
  const callId = callByUser.get(a) || callByUser.get(b);
  if (!callId) return null;
  const call = callsById.get(callId);
  if (!call) return null;
  const peers = new Set([call.callerId, call.calleeId]);
  if (!peers.has(a) || !peers.has(b)) return null;
  return call;
}

function messagesFor(chatId: string) {
  if (!chatMessages.has(chatId)) chatMessages.set(chatId, []);
  return chatMessages.get(chatId)!;
}

function clearChatMessages(chatId: string) {
  chatMessages.set(chatId, []);
  persistMessages();
}

function removeMessage(chatId: string, messageId: string) {
  const list = messagesFor(chatId);
  const index = list.findIndex((item) => item.id === messageId);
  if (index < 0) return null;
  const [removed] = list.splice(index, 1);
  persistMessages();
  return removed;
}

/** Soft-delete: keep a system tombstone so replies / history stay coherent. */
function makeDeletedTombstone(message: ChatMessage): ChatMessage {
  const fileGone = message.kind === "file";
  return {
    id: message.id,
    room: message.room,
    author: "Pulse",
    text: fileGone ? "Файл удалён из сообщения" : "Сообщение удалено",
    createdAt: message.createdAt,
    kind: "system",
  };
}

function redactMessage(chatId: string, messageId: string) {
  const list = messagesFor(chatId);
  const index = list.findIndex((item) => item.id === messageId);
  if (index < 0) return null;
  const original = list[index];
  if (original.kind === "system") return null;

  const tombstone = makeDeletedTombstone(original);
  list[index] = tombstone;

  const replyUpdates: ChatMessage[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item.replyTo?.id !== messageId) continue;
    list[i] = {
      ...item,
      replyTo: {
        ...item.replyTo,
        text: tombstone.text,
      },
    };
    replyUpdates.push(list[i]);
  }

  persistMessages();
  return { tombstone, replyUpdates, original };
}

/** Mark pending invites to a deleted group as expired across all DMs. */
function expireInvitesForGroup(
  io: Server,
  groupId: string,
  groupTitle: string,
) {
  for (const [chatId, list] of chatMessages.entries()) {
    let touched = false;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (
        item.kind !== "invite" ||
        !item.invite ||
        item.invite.groupId !== groupId ||
        item.invite.status !== "pending"
      ) {
        continue;
      }
      list[i] = {
        ...item,
        text: `Группа «${groupTitle}» удалена`,
        invite: {
          ...item.invite,
          status: "expired",
        },
      };
      touched = true;
      io.to(chatId).emit("message:update", publicMessage(list[i]));
      const chat = getChat(chatId);
      if (chat) notifyChatMembers(io, chat);
    }
    if (touched) persistMessages();
  }
}

function kickSocketsFromChat(io: Server, chatId: string) {
  for (const [socketId, presence] of usersBySocket.entries()) {
    if (presence.room !== chatId) continue;
    const memberSocket = io.sockets.sockets.get(socketId);
    if (memberSocket) memberSocket.leave(chatId);
    presence.room = null;
    usersBySocket.set(socketId, presence);
  }
}

function kickUserFromGroup(io: Server, userId: string, chatId: string) {
  for (const [socketId, presence] of usersBySocket.entries()) {
    if (presence.userId !== userId) continue;
    const memberSocket = io.sockets.sockets.get(socketId);
    if (!memberSocket) continue;

    const channelId = voiceBySocket.get(socketId) || voiceByUser.get(userId);
    if (channelId) {
      const found = findVoiceChannel(channelId);
      if (found?.group.id === chatId) {
        leaveVoiceChannel(io, memberSocket, userId);
      }
    }

    if (presence.room === chatId) {
      memberSocket.leave(chatId);
      presence.room = null;
      usersBySocket.set(socketId, presence);
      memberSocket.emit("chat:left", { chatId });
    }
  }

  // A temporarily disconnected socket may still own voice presence during
  // the reconnect grace period and is no longer present in usersBySocket.
  const channelId = voiceByUser.get(userId);
  const found = channelId ? findVoiceChannel(channelId) : null;
  if (channelId && found?.group.id === chatId) {
    const reconnectTimer = voiceDisconnectTimers.get(userId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    voiceDisconnectTimers.delete(userId);
    const room = voiceByChannel.get(channelId);
    const member = room?.get(userId);
    if (member) {
      room?.delete(userId);
      voiceBySocket.delete(member.socketId);
      if (room?.size === 0) voiceByChannel.delete(channelId);
    }
    voiceByUser.delete(userId);
    void removeLiveKitParticipant(channelId, userId);
    emitVoiceState(io, found.group);
  }
}

function presenceNames(room: string) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const user of usersBySocket.values()) {
    if (user.room !== room || !user.name) continue;
    const key = user.userId || user.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(user.name);
  }
  return names;
}

function onlineUserIds() {
  return new Set(
    [...usersBySocket.values()]
      .filter((user) => Boolean(user.userId))
      .map((user) => user.userId),
  );
}

function contactIdsFor(userId: string) {
  const ids = new Set<string>([userId]);
  for (const chat of listChatsForUser(userId)) {
    if (chat.type === "channel") continue;
    for (const memberId of chat.memberIds) ids.add(memberId);
  }
  return ids;
}

function publicAccount(account: AuthAccount): AuthAccount {
  return {
    ...account,
    avatarUrl: account.avatarUrl
      ? signAvatarUrl(bareUploadUrl(account.avatarUrl))
      : undefined,
  };
}

function publicMessage(message: ChatMessage): ChatMessage {
  const attachments = messageAttachments(message);
  if (!attachments.length) return message;
  const signed = attachments.map((file) => ({
    ...file,
    url: signUploadUrl(bareUploadUrl(file.url)),
  }));
  return {
    ...message,
    file: signed[0],
    files: signed.length > 1 ? signed : undefined,
  };
}

/** Hide join/leave spam from the thread (presence still updates separately). */
function isPresenceNotice(message: ChatMessage) {
  if (message.kind !== "system") return false;
  return / (в чате|вышел)$/.test(String(message.text || "").trim());
}

function historyForClient(chatId: string) {
  return messagesFor(chatId)
    .filter((message) => !isPresenceNotice(message))
    .map(publicMessage);
}

function peopleForViewer(viewerId: string) {
  const contacts = contactIdsFor(viewerId);
  const online = onlineUserIds();
  return listUsers()
    .filter((user) => contacts.has(user.id))
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
        ? signAvatarUrl(bareUploadUrl(user.avatarUrl))
        : undefined,
      bio: user.id === viewerId ? user.bio : "",
      lastSeenAt: user.id === viewerId ? user.lastSeenAt : undefined,
      online: online.has(user.id),
    }))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, "ru");
    });
}

function searchPeople(viewerId: string, queryRaw: string) {
  const query = queryRaw.trim().toLowerCase();
  if (query.length < 1) return [];
  const online = onlineUserIds();

  function score(user: { username: string; displayName: string }) {
    const username = user.username.toLowerCase();
    const display = user.displayName.toLowerCase();
    if (username === query || display === query) return 0;
    if (username.startsWith(query)) return 1;
    if (display.startsWith(query)) return 2;
    if (username.includes(query)) return 3;
    if (display.includes(query)) return 4;
    return 99;
  }

  return listUsers()
    .filter((user) => {
      if (user.id === viewerId) return false;
      return score(user) < 99;
    })
    .sort((a, b) => {
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      return a.displayName.localeCompare(b.displayName, "ru");
    })
    .slice(0, 100)
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
        ? signAvatarUrl(bareUploadUrl(user.avatarUrl))
        : undefined,
      bio: "",
      online: online.has(user.id),
    }));
}

function suggestPeople(viewerId: string) {
  const online = onlineUserIds();
  return listUsers()
    .filter((user) => user.id !== viewerId)
    .sort((a, b) => {
      const aOnline = online.has(a.id);
      const bOnline = online.has(b.id);
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, "ru");
    })
    .slice(0, 24)
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
        ? signAvatarUrl(bareUploadUrl(user.avatarUrl))
        : undefined,
      bio: "",
      online: online.has(user.id),
    }));
}

function publicGroupHits(viewerId: string, query: string) {
  return searchPublicGroups(viewerId, query).map((hit) => ({
    ...hit,
    avatarUrl: hit.avatarUrl
      ? signAvatarUrl(bareUploadUrl(hit.avatarUrl))
      : undefined,
  }));
}

function labelOf(account: AuthAccount) {
  return account.displayName || account.username;
}

function chatInfo(chat: ChatMeta, viewerId: string) {
  const messages = messagesFor(chat.id);
  const last = [...messages].reverse().find((item) => item.kind !== "system");
  const previewText =
    last?.kind === "file"
      ? albumPreviewText(messageAttachments(last), last.text)
      : last?.kind === "call"
        ? last.text
        : last?.text;

  const group =
    chat.type === "group" ? ensureVoiceChannels(chat) : chat;

  return {
    id: chat.id,
    type: chat.type,
    title: dmTitleForViewer(chat, viewerId),
    topic: chat.topic,
    online: presenceNames(chat.id).length,
    messages: messages.filter((item) => item.kind !== "system").length,
    members: chat.type === "channel" ? onlineUserIds().size : chat.memberIds.length,
    unreadCount: unreadCountFor(chat.id, viewerId),
    pinned: isPinned(viewerId, chat.id),
    peerId: peerIdForViewer(chat, viewerId),
    avatarUrl: chat.avatarUrl
      ? signAvatarUrl(bareUploadUrl(chat.avatarUrl))
      : undefined,
    createdBy: chat.createdBy,
    memberIds: chat.type === "group" ? [...chat.memberIds] : undefined,
    visibility: chat.type === "group" ? groupVisibility(chat) : undefined,
    lastMessage: last
      ? {
          author: last.author,
          text: previewText || "",
          createdAt: last.createdAt,
        }
      : null,
    createdAt: chat.createdAt,
    voiceChannels:
      group.type === "group"
        ? (group.voiceChannels || []).map((channel) => ({
            id: channel.id,
            title: channel.title,
            users: voiceUsersForChannel(channel.id),
          }))
        : undefined,
  };
}

function voiceUsersForChannel(channelId: string) {
  const members = voiceByChannel.get(channelId);
  if (!members) return [];
  return [...members.values()].map((member) => ({
    userId: member.userId,
    name: member.name,
    muted: member.muted,
    deafened: member.deafened,
    speaking: member.speaking,
    cameraOff: member.cameraOff,
    sharingScreen: member.sharingScreen,
    mediaRevision: member.mediaRevision,
    avatarUrl: member.avatarUrl
      ? signAvatarUrl(bareUploadUrl(member.avatarUrl))
      : undefined,
  }));
}

function voiceStateForGroup(group: ChatMeta) {
  ensureVoiceChannels(group);
  return {
    groupId: group.id,
    channels: (group.voiceChannels || []).map((channel) => {
      const topo = voiceTopologyInfo(channel.id);
      return {
        id: channel.id,
        title: channel.title,
        users: voiceUsersForChannel(channel.id),
        topology: topo.topology,
        topologyEpoch: topo.topologyEpoch,
      };
    }),
  };
}

function emitVoiceState(io: Server, group: ChatMeta) {
  const payload = voiceStateForGroup(group);
  for (const memberId of group.memberIds) {
    emitToUser(io, memberId, "voice:state", payload);
  }
}

function clearVoiceChannelPresence(channelId: string) {
  const room = voiceByChannel.get(channelId);
  if (!room) return;
  for (const [userId, member] of room) {
    voiceBySocket.delete(member.socketId);
    if (voiceByUser.get(userId) === channelId) voiceByUser.delete(userId);
  }
  voiceByChannel.delete(channelId);
  voiceTopologyEpoch.delete(channelId);
}

function leaveVoiceChannel(
  io: Server,
  socket: Socket,
  userId: string,
  opts?: { quiet?: boolean },
) {
  const channelId = voiceBySocket.get(socket.id) || voiceByUser.get(userId);
  if (!channelId) return null;

  const found = findVoiceChannel(channelId);
  const room = voiceByChannel.get(channelId);
  const previousSize = room?.size || 0;
  let removedParticipant = false;
  if (room) {
    const member = room.get(userId);
    if (member && member.socketId === socket.id) {
      room.delete(userId);
      removedParticipant = true;
      if (room.size === 0) voiceByChannel.delete(channelId);
    } else if (member && member.socketId !== socket.id) {
      // Another tab owns presence — only drop this socket mapping.
      voiceBySocket.delete(socket.id);
      return found?.group || null;
    }
  }

  voiceBySocket.delete(socket.id);
  if (voiceByUser.get(userId) === channelId) {
    voiceByUser.delete(userId);
    removedParticipant = true;
  }
  if (removedParticipant) {
    void removeLiveKitParticipant(channelId, userId);
    maybeBumpVoiceTopology(channelId, previousSize);
  }

  if (found && !opts?.quiet) emitVoiceState(io, found.group);
  if (removedParticipant) persistLiveMedia();
  return found?.group || null;
}

function classifyRoomFile(file: NonNullable<ChatMessage["file"]>): {
  category: RoomMediaItem["category"];
  kind: RoomMediaItem["kind"];
} {
  if (isVideoAttachment(file)) return { category: "media", kind: "video" };
  if (isImageAttachment(file)) return { category: "media", kind: "image" };
  if (isAudioAttachment(file)) return { category: "audio", kind: "file" };
  return { category: "file", kind: "file" };
}

function collectRoomMedia(
  chatId: string,
  filter: "media" | "file" | "all",
): RoomMediaItem[] {
  const items: RoomMediaItem[] = [];
  for (const message of messagesFor(chatId)) {
    if (message.kind !== "file") continue;
    for (const file of messageAttachments(message)) {
      const classified = classifyRoomFile(file);
      if (filter === "media" && classified.category !== "media") continue;
      if (filter === "file" && classified.category === "media") continue;
      items.push({
        messageId: message.id,
        createdAt: message.createdAt,
        author: message.author,
        category: classified.category,
        kind: classified.kind,
        file: {
          ...file,
          url: signUploadUrl(bareUploadUrl(file.url)),
        },
      });
    }
  }
  items.reverse();
  return items;
}

function socketsForUser(userId: string) {
  return [...usersBySocket.entries()]
    .filter(([, presence]) => presence.userId === userId)
    .map(([socketId]) => socketId);
}

function emitToUser(io: Server, userId: string, event: string, payload: unknown) {
  for (const socketId of socketsForUser(userId)) {
    io.to(socketId).emit(event, payload);
  }
}

function pushMessage(io: Server, chat: ChatMeta, message: ChatMessage) {
  const list = messagesFor(chat.id);
  const attachments = messageAttachments(message).map((file) => ({
    ...file,
    url: bareUploadUrl(file.url),
  }));
  if (attachments.length) {
    message = {
      ...message,
      file: attachments[0],
      files: attachments.length > 1 ? attachments : undefined,
    };
  }
  list.push(message);
  if (list.length > 200) list.shift();
  persistMessages();

  // Only the author is auto-marked read; viewers emit chats:read themselves
  // so background tabs keep unread badges.
  if (message.authorId) {
    markChatRead(message.authorId, chat.id);
  }

  const outbound = publicMessage(message);
  io.to(chat.id).emit("message", outbound);
  notifyChatMembers(io, chat);

  // Lightweight ping for members currently in another room (sound / desktop notify).
  if (
    message.kind !== "system" &&
    message.kind !== "call" &&
    message.authorId
  ) {
    const preview =
      message.kind === "file"
        ? albumPreviewText(messageAttachments(message), message.text)
        : message.text;

    if (chat.type === "channel") {
      const ping = {
        room: chat.id,
        author: "Pulse",
        text: `Новое сообщение в #${chat.title}`,
      };
      for (const [socketId, presence] of usersBySocket.entries()) {
        if (!presence.userId || presence.userId === message.authorId) continue;
        if (presence.room === chat.id) continue;
        io.to(socketId).emit("message:ping", ping);
      }
    } else {
      const ping = {
        room: chat.id,
        author: message.author,
        text: preview.slice(0, 180),
      };
      for (const userId of chat.memberIds) {
        if (userId === message.authorId) continue;
        let viewing = false;
        for (const socketId of socketsForUser(userId)) {
          const presence = usersBySocket.get(socketId);
          if (presence?.room === chat.id) {
            viewing = true;
            continue;
          }
          io.to(socketId).emit("message:ping", ping);
        }
        // Wake suspended phone tabs that dropped the socket.
        if (!viewing) {
          void sendPushToUser(userId, {
            title: String(message.author || "Pulse"),
            body: String(preview || "Новое сообщение").slice(0, 180),
            chatId: chat.id,
            kind: "message",
            tag: `pulse-${chat.id}`,
          });
        }
      }
    }
  }
}

function chatsForUser(userId: string) {
  return listChatsForUser(userId)
    .filter(
      (chat) =>
        chat.type !== "dm" ||
        !chat.visibleTo ||
        chat.visibleTo.includes(userId) ||
        messagesFor(chat.id).some((item) => item.kind !== "system"),
    )
    .map((chat) => chatInfo(chat, userId))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aTime = a.lastMessage?.createdAt ?? a.createdAt;
      const bTime = b.lastMessage?.createdAt ?? b.createdAt;
      return bTime - aTime;
    });
}

function emitChats(socket: Socket, userId: string) {
  socket.emit("chats", chatsForUser(userId));
}

function broadcastPeople(io: Server) {
  for (const [socketId, presence] of usersBySocket.entries()) {
    if (!presence.userId) continue;
    io.to(socketId).emit("people", peopleForViewer(presence.userId));
  }
}

function notifyChatMembers(io: Server, chat: ChatMeta) {
  if (chat.type === "channel") {
    for (const [socketId, presence] of usersBySocket.entries()) {
      if (!presence.userId) continue;
      const socket = io.sockets.sockets.get(socketId);
      if (socket) emitChats(socket, presence.userId);
    }
    return;
  }

  for (const [socketId, presence] of usersBySocket.entries()) {
    if (!chat.memberIds.includes(presence.userId)) continue;
    const socket = io.sockets.sockets.get(socketId);
    if (socket) emitChats(socket, presence.userId);
  }
}

function pushSystem(room: string, text: string) {
  const message: ChatMessage = {
    id: randomUUID(),
    room,
    author: "Pulse",
    text,
    createdAt: Date.now(),
    kind: "system",
  };
  const list = messagesFor(room);
  list.push(message);
  if (list.length > 200) list.shift();
  persistMessages();
  return message;
}

function leaveCurrentRoom(io: Server, socket: Socket, _quiet = false) {
  const previous = usersBySocket.get(socket.id);
  if (!previous?.room) return;

  socket.leave(previous.room);
  const chat = getChat(previous.room);
  io.to(previous.room).emit("presence", {
    chatId: previous.room,
    names: presenceNames(previous.room),
  });
  previous.room = null;
  usersBySocket.set(socket.id, previous);
  if (chat) notifyChatMembers(io, chat);
}

function joinChat(
  io: Server,
  socket: Socket,
  account: AuthAccount,
  chatId: string,
) {
  const chat = getChat(chatId);
  if (!chat) return { ok: false as const, error: "Чат не найден" };
  if (!canAccessChat(chat, account.userId)) {
    return { ok: false as const, error: "Нет доступа к этому чату" };
  }

  const previous = usersBySocket.get(socket.id);
  if (previous?.room === chat.id) {
    // Re-send history so clients that cleared the list (same-chat reopen) recover.
    markChatRead(account.userId, chat.id);
    socket.emit("history", {
      chatId: chat.id,
      messages: historyForClient(chat.id),
    });
    return {
      ok: true as const,
      session: { name: labelOf(account), room: chat.id },
    };
  }

  leaveCurrentRoom(io, socket, chat.type === "dm");

  socket.join(chat.id);
  usersBySocket.set(socket.id, {
    userId: account.userId,
    name: labelOf(account),
    room: chat.id,
  });

  // Presence updates below — don't spam the thread with join notices.

  markChatRead(account.userId, chat.id);
  socket.emit("history", {
    chatId: chat.id,
    messages: historyForClient(chat.id),
  });
  io.to(chat.id).emit("presence", {
    chatId: chat.id,
    names: presenceNames(chat.id),
  });
  notifyChatMembers(io, chat);
  broadcastPeople(io);

  return {
    ok: true as const,
    session: { name: labelOf(account), room: chat.id },
  };
}

function requireAccount(socket: Socket) {
  return getSocketAccount(socket.id);
}

function ringingCallForUser(userId: string) {
  const callId = callByUser.get(userId);
  if (!callId) return null;
  const call = callsById.get(callId);
  if (!call || call.status !== "ringing") return null;
  if (call.calleeId !== userId) return null;
  return call;
}

function afterAuth(io: Server, socket: Socket, account: AuthAccount) {
  cancelCallDisconnectTimer(account.userId);
  const voiceGrace = voiceDisconnectTimers.get(account.userId);
  if (voiceGrace) {
    clearTimeout(voiceGrace);
    voiceDisconnectTimers.delete(account.userId);
  }
  const existing = usersBySocket.get(socket.id);
  usersBySocket.set(socket.id, {
    userId: account.userId,
    name: labelOf(account),
    room: existing?.room ?? null,
  });
  emitChats(socket, account.userId);
  broadcastPeople(io);

  // Re-deliver ringing call after phone woke / tab reconnected.
  const ringing = ringingCallForUser(account.userId);
  if (ringing) {
    const caller = getUserById(ringing.callerId);
    socket.emit("call:incoming", {
      callId: ringing.callId,
      fromUserId: ringing.callerId,
      fromName: caller?.displayName || caller?.username || "Pulse",
      mode: ringing.mode,
      chatId: ringing.chatId,
    });
  }

  const liveCallId = callByUser.get(account.userId);
  const liveCall = liveCallId ? callsById.get(liveCallId) : null;
  if (liveCall && liveCall.status === "active") {
    const peerId =
      liveCall.callerId === account.userId ? liveCall.calleeId : liveCall.callerId;
    const peer = getUserById(peerId);
    const peerPresent = userIsConnected(peerId);
    socket.emit("call:resume", {
      callId: liveCall.callId,
      peerId,
      peerName: peer?.displayName || peer?.username || "Pulse",
      mode: liveCall.mode,
      chatId: liveCall.chatId,
      role: liveCall.callerId === account.userId ? "caller" : "callee",
      peerPresent,
    });
    if (peerPresent && socketsForUser(account.userId).length <= 1) {
      emitToUser(io, peerId, "call:resume", {
        callId: liveCall.callId,
        peerId: account.userId,
        peerName: labelOf(account),
        mode: liveCall.mode,
        chatId: liveCall.chatId,
        role: liveCall.callerId === peerId ? "caller" : "callee",
        peerPresent: true,
      });
    }
  }
}

function refreshPresenceName(io: Server, account: AuthAccount) {
  for (const [socketId, presence] of usersBySocket.entries()) {
    if (presence.userId !== account.userId) continue;
    presence.name = labelOf(account);
    usersBySocket.set(socketId, presence);
    if (presence.room) {
      io.to(presence.room).emit("presence", {
        chatId: presence.room,
        names: presenceNames(presence.room),
      });
    }
  }
}

app.prepare().then(() => {
  const httpServer = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "connect-src 'self' blob: ws: wss: stun: turn: turns:",
        "font-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    );
    if (!dev) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }

    const url = req.url || "";
    if (url.startsWith("/livekit")) {
      proxyLiveKitHttp(req, res);
      return;
    }
    if (url.startsWith("/api/health/livekit")) {
      res.setHeader("Content-Type", "application/json");
      const service = liveKitRoomService();
      if (!service) {
        res.statusCode = 503;
        res.end(JSON.stringify({ ok: false, service: "livekit" }));
        return;
      }
      void service.listRooms().then(
        () => {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              ok: true,
              service: "livekit",
              mode: "self-hosted",
            }),
          );
        },
        () => {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, service: "livekit" }));
        },
      );
      return;
    }
    if (url.startsWith("/api/health")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "pulse", bootId: APP_BOOT_ID }));
      return;
    }
    if (url.startsWith("/api/livekit/token")) {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("Method not allowed");
        return;
      }
      const token = String(req.headers["x-pulse-token"] || "");
      const session = restoreSession(token);
      if (!session.ok) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }
      const account = session.account;
      if (!rateLimit(`livekit-token:${account.userId}`, 30, 60_000)) {
        res.statusCode = 429;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Too many requests" }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size <= 8192) chunks.push(Buffer.from(chunk));
      });
      req.on("end", () => {
        void (async () => {
          try {
            if (size > 8192) throw new Error("Payload too large");
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              channelId?: string;
            };
            const channelId = String(body.channelId || "");
            const found = findVoiceChannel(channelId);
            if (!found || !canAccessChat(found.group, account.userId)) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: "Канал не найден" }));
              return;
            }
            const voiceMember = voiceByChannel
              .get(channelId)
              ?.get(account.userId);
            if (
              voiceByUser.get(account.userId) !== channelId ||
              !voiceMember
            ) {
              res.statusCode = 403;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  ok: false,
                  error: "Сначала войдите в голосовой канал",
                }),
              );
              return;
            }
            const config = loadLiveKitConfig();
            if (!config.url || !config.apiKey || !config.apiSecret) {
              res.statusCode = 503;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  ok: false,
                  error:
                    "SFU не настроен: нужен свой LiveKit на этой ВМ (не Cloud). Локально: docker compose -f docker-compose.livekit.yml up",
                }),
              );
              return;
            }
            const participant = new AccessToken(
              config.apiKey,
              config.apiSecret,
              {
                identity: account.userId,
                name: labelOf(account),
                ttl: "1h",
              },
            );
            participant.addGrant({
              roomJoin: true,
              room: liveKitRoomName(channelId),
              canPublish: true,
              canSubscribe: true,
              canPublishData: true,
              canPublishSources: [
                TrackSource.CAMERA,
                TrackSource.MICROPHONE,
                TrackSource.SCREEN_SHARE,
                TrackSource.SCREEN_SHARE_AUDIO,
              ],
            });
            const participantToken = await participant.toJwt();
            res.statusCode = 201;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              JSON.stringify({
                ok: true,
                serverUrl: publicLiveKitUrl(req),
                participantToken,
              }),
            );
          } catch {
            if (res.writableEnded) return;
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Bad request" }));
          }
        })();
      });
      return;
    }
    if (url.startsWith("/api/ice")) {
      const token = String(req.headers["x-pulse-token"] || "");
      const session = restoreSession(token);
      if (!session.ok) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }
      const turn = loadTurnSecrets();
      const host =
        (process.env.TURN_HOST || "").trim() ||
        (() => {
          try {
            return publicOrigin ? new URL(publicOrigin).hostname : "";
          } catch {
            return "";
          }
        })();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(
        JSON.stringify({
          ok: true,
          iceServers: buildIceServers({
            turnHost: host,
            turnUser: turn.user,
            turnPass: turn.pass,
          }),
        }),
      );
      return;
    }
    if (url.startsWith("/api/push/vapid")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.end(JSON.stringify({ ok: true, publicKey: getVapidPublicKey() }));
      return;
    }
    if (url.startsWith("/api/push/subscribe")) {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("Method not allowed");
        return;
      }
      const token = String(req.headers["x-pulse-token"] || "");
      const session = restoreSession(token);
      if (!session.ok) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            subscription?: {
              endpoint?: string;
              expirationTime?: number | null;
              keys?: { p256dh?: string; auth?: string };
            };
            unsubscribe?: boolean;
          };
          const endpoint = String(body.subscription?.endpoint || "");
          if (!endpoint) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Bad subscription" }));
            return;
          }
          if (body.unsubscribe) {
            removePushSubscription(session.account.userId, endpoint);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          const p256dh = String(body.subscription?.keys?.p256dh || "");
          const auth = String(body.subscription?.keys?.auth || "");
          if (!p256dh || !auth) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Bad keys" }));
            return;
          }
          savePushSubscription(session.account.userId, {
            endpoint,
            expirationTime: body.subscription?.expirationTime ?? null,
            keys: { p256dh, auth },
          });
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: "Bad JSON" }));
        }
      });
      return;
    }
    if (url.startsWith("/api/ringtones")) {
      void handleRingtones(req, res);
      return;
    }
    if (url.startsWith("/api/upload")) {
      handleUpload(req, res);
      return;
    }
    if (tryServeUpload(req, res)) return;

    const parsedUrl = parse(url, true);
    handle(req, res, parsedUrl);
  });

  const io = new Server(httpServer, {
    path: "/api/socket",
    maxHttpBufferSize: 1e6,
    pingInterval: 15_000,
    pingTimeout: 45_000,
    connectTimeout: 20_000,
    perMessageDeflate: false,
    httpCompression: false,
  // Allow both the public tunnel origin and local/dev origins.
  cors: {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (publicOrigin && origin === publicOrigin) {
        callback(null, true);
        return;
      }
      try {
        const host = new URL(origin).hostname;
        if (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host.endsWith(".local") ||
          host.endsWith(".trycloudflare.com") ||
          (dev && isDevAccessibleHost(host))
        ) {
          callback(null, true);
          return;
        }
      } catch {
        /* fall through */
      }
      callback(null, Boolean(dev) || !publicOrigin);
    },
    methods: ["GET", "POST"],
  },
  });

  function clientKey(socket: Socket) {
    // Prefer the real TCP peer. Only trust X-Forwarded-For behind a known proxy.
    if (process.env.TRUST_PROXY === "1") {
      const forwarded = String(
        socket.handshake.headers["x-forwarded-for"] || "",
      )
        .split(",")[0]
        .trim();
      if (forwarded) return forwarded;
    }
    return socket.handshake.address || socket.id;
  }

  function revokeSocketSession(revokedToken: string) {
    for (const socketId of socketIdsForToken(revokedToken)) {
      const target = io.sockets.sockets.get(socketId);
      if (target) {
        leaveCurrentRoom(io, target, true);
        target.emit("auth:expired");
        target.disconnect(true);
      }
      usersBySocket.delete(socketId);
      unbindSocketAuth(socketId);
    }
    broadcastPeople(io);
  }

  onSessionRevoked(({ revokedToken }) => {
    revokeSocketSession(revokedToken);
  });

  io.on("connection", (socket) => {
    socket.emit("app:boot", { bootId: APP_BOOT_ID });
    // people list only after auth — see afterAuth / broadcastPeople

    socket.on(
      "auth:register",
      (
        payload: { username?: string; password?: string },
        ack?: (result: {
          ok: boolean;
          account?: AuthAccount;
          error?: string;
        }) => void,
      ) => {
        if (!rateLimit(`auth:${clientKey(socket)}`, 30, 60_000)) {
          ack?.({ ok: false, error: "Слишком много попыток, подождите" });
          return;
        }
        // Unbind first so session rotation does not kick this socket.
        unbindSocketAuth(socket.id);
        const result = registerUser(
          String(payload?.username || ""),
          String(payload?.password || ""),
        );
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        bindSocketAuth(socket.id, result.account.token);
        afterAuth(io, socket, result.account);
        ack?.({ ok: true, account: publicAccount(result.account) });
      },
    );

    socket.on(
      "auth:login",
      (
        payload: { username?: string; password?: string },
        ack?: (result: {
          ok: boolean;
          account?: AuthAccount;
          error?: string;
        }) => void,
      ) => {
        if (!rateLimit(`auth:${clientKey(socket)}`, 30, 60_000)) {
          ack?.({ ok: false, error: "Слишком много попыток, подождите" });
          return;
        }
        // Unbind first so session rotation does not kick this socket.
        unbindSocketAuth(socket.id);
        const result = loginUser(
          String(payload?.username || ""),
          String(payload?.password || ""),
        );
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        bindSocketAuth(socket.id, result.account.token);
        afterAuth(io, socket, result.account);
        ack?.({ ok: true, account: publicAccount(result.account) });
      },
    );

    socket.on(
      "auth:restore",
      (
        payload: { token?: string },
        ack?: (result: {
          ok: boolean;
          account?: AuthAccount;
          error?: string;
        }) => void,
      ) => {
        if (!rateLimit(`auth:${clientKey(socket)}`, 30, 60_000)) {
          ack?.({ ok: false, error: "Слишком много попыток, подождите" });
          return;
        }
        const result = restoreSession(payload?.token);
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        bindSocketAuth(socket.id, result.account.token);
        afterAuth(io, socket, result.account);
        ack?.({ ok: true, account: publicAccount(result.account) });
      },
    );

    socket.on("auth:logout", () => {
      const account = getSocketAccount(socket.id);
      if (account) {
        const reconnectTimer = voiceDisconnectTimers.get(account.userId);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        voiceDisconnectTimers.delete(account.userId);
        leaveVoiceChannel(io, socket, account.userId);
        touchLastSeen(account.userId);
      }
      leaveCurrentRoom(io, socket, true);
      usersBySocket.delete(socket.id);
      unbindSocketAuth(socket.id);
      logoutToken(account?.token);
      broadcastPeople(io);
    });

    socket.on(
      "profile:update",
      (
        payload: {
          displayName?: string;
          bio?: string;
          avatarUrl?: string | null;
        },
        ack?: (result: {
          ok: boolean;
          account?: AuthAccount;
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }

        if (!rateLimit(`profile:${account.userId}`, 20, 60_000)) {
          ack?.({ ok: false, error: "Слишком много обновлений профиля" });
          return;
        }

        let avatarUrl = payload?.avatarUrl;
        if (typeof avatarUrl === "string" && avatarUrl) {
          avatarUrl = bareUploadUrl(avatarUrl);
          if (!isValidStoredAvatar(avatarUrl)) {
            ack?.({ ok: false, error: "Некорректный аватар" });
            return;
          }
        }

        const result = updateProfile(account.userId, {
          displayName: payload?.displayName,
          bio: payload?.bio,
          avatarUrl,
        });

        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }

        bindSocketAuth(socket.id, result.account.token || account.token);
        afterAuth(io, socket, result.account);
        refreshPresenceName(io, result.account);
        for (const chat of listChatsForUser(result.account.userId)) {
          notifyChatMembers(io, chat);
        }
        ack?.({ ok: true, account: publicAccount(result.account) });
      },
    );

    socket.on(
      "people:search",
      (
        payload: { query?: string },
        ack?: (result: {
          ok: boolean;
          users?: ReturnType<typeof searchPeople>;
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Нужен вход" });
          return;
        }
        if (!rateLimit(`people-search:${account.userId}`, 30, 60_000)) {
          ack?.({ ok: false, error: "Слишком много запросов" });
          return;
        }
        ack?.({
          ok: true,
          users: searchPeople(account.userId, String(payload?.query || "")),
        });
      },
    );

    socket.on(
      "people:suggest",
      (
        _payload: Record<string, never> | undefined,
        ack?: (result: {
          ok: boolean;
          users?: ReturnType<typeof suggestPeople>;
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Нужен вход" });
          return;
        }
        if (!rateLimit(`people-suggest:${account.userId}`, 20, 60_000)) {
          ack?.({ ok: false, error: "Слишком много запросов" });
          return;
        }
        ack?.({ ok: true, users: suggestPeople(account.userId) });
      },
    );

    socket.on(
      "groups:search",
      (
        payload: { query?: string },
        ack?: (result: {
          ok: boolean;
          groups?: ReturnType<typeof publicGroupHits>;
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Нужен вход" });
          return;
        }
        if (!rateLimit(`groups-search:${account.userId}`, 30, 60_000)) {
          ack?.({ ok: false, error: "Слишком много запросов" });
          return;
        }
        ack?.({
          ok: true,
          groups: publicGroupHits(
            account.userId,
            String(payload?.query || ""),
          ),
        });
      },
    );

    socket.on(
      "group:join",
      (
        payload: { groupId?: string },
        ack?: (result: {
          ok: boolean;
          session?: { name: string; room: string };
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        if (!rateLimit(`group-join:${account.userId}`, 20, 60_000)) {
          ack?.({ ok: false, error: "Слишком много запросов" });
          return;
        }
        const groupId = String(payload?.groupId || "");
        if (!groupId) {
          ack?.({ ok: false, error: "Группа не указана" });
          return;
        }
        const joined = joinPublicGroup(account.userId, groupId);
        if (!joined.ok) {
          ack?.({ ok: false, error: joined.error });
          return;
        }
        // Refresh chat lists + contact people only for group members (not all users).
        notifyChatMembers(io, joined.chat);
        for (const memberId of joined.chat.memberIds) {
          emitToUser(io, memberId, "people", peopleForViewer(memberId));
        }
        const result = joinChat(io, socket, account, joined.chat.id);
        ack?.(result);
      },
    );

    socket.on(
      "group:leave",
      (
        payload: { chatId?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        if (!rateLimit(`group-leave:${account.userId}`, 12, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }
        const chatId = String(payload?.chatId || "");
        if (!chatId) {
          ack?.({ ok: false, error: "Чат не указан" });
          return;
        }

        const left = leaveGroup(chatId, account.userId);
        if (!left.ok) {
          ack?.({ ok: false, error: left.error });
          return;
        }

        kickUserFromGroup(io, account.userId, chatId);
        notifyChatMembers(io, left.chat);
        for (const memberId of left.chat.memberIds) {
          emitToUser(io, memberId, "people", peopleForViewer(memberId));
        }
        for (const socketId of socketsForUser(account.userId)) {
          const memberSocket = io.sockets.sockets.get(socketId);
          if (memberSocket) emitChats(memberSocket, account.userId);
        }

        ack?.({ ok: true });
      },
    );

    socket.on(
      "group:visibility",
      (
        payload: { groupId?: string; visibility?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        if (!rateLimit(`group-visibility:${account.userId}`, 20, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }
        const groupId = String(payload?.groupId || "");
        if (!groupId) {
          ack?.({ ok: false, error: "Группа не указана" });
          return;
        }
        const visibility = payload?.visibility === "private" ? "private" : "public";
        const updated = updateGroupVisibility(
          groupId,
          account.userId,
          visibility,
        );
        if (!updated.ok) {
          ack?.({ ok: false, error: updated.error });
          return;
        }
        notifyChatMembers(io, updated.chat);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "join",
      (
        payload: { room?: string },
        ack?: (result: {
          ok: boolean;
          session?: { name: string; room: string };
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        const result = joinChat(
          io,
          socket,
          account,
          String(payload?.room || "lobby"),
        );
        ack?.(result);
      },
    );

    socket.on(
      "dm:open",
      (
        payload: { userId?: string },
        ack?: (result: {
          ok: boolean;
          session?: { name: string; room: string };
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }

        if (!rateLimit(`dm:${account.userId}`, 30, 60_000)) {
          ack?.({ ok: false, error: "Слишком много запросов" });
          return;
        }

        const targetId = String(payload?.userId || "");
        if (targetId === account.userId) {
          ack?.({ ok: false, error: "Нельзя открыть чат с собой" });
          return;
        }
        if (!getUserById(targetId)) {
          ack?.({ ok: false, error: "Пользователь не найден" });
          return;
        }

        const opened = openDm(account.userId, targetId);
        if (!opened.ok) {
          ack?.({ ok: false, error: opened.error });
          return;
        }

        notifyChatMembers(io, opened.chat);
        const result = joinChat(io, socket, account, opened.chat.id);
        ack?.(result);
      },
    );

    socket.on(
      "group:create",
      (
        payload: {
          title?: string;
          topic?: string;
          memberIds?: string[];
          visibility?: string;
        },
        ack?: (result: {
          ok: boolean;
          session?: { name: string; room: string };
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }

        if (!rateLimit(`group:${account.userId}`, 10, 60_000)) {
          ack?.({ ok: false, error: "Слишком много групп" });
          return;
        }

        const visibility =
          payload?.visibility === "private" ? "private" : "public";
        const created = createGroup(
          account.userId,
          String(payload?.title || ""),
          String(payload?.topic || ""),
          Array.isArray(payload?.memberIds) ? payload.memberIds : [],
          visibility,
        );
        if (!created.ok) {
          ack?.({ ok: false, error: created.error });
          return;
        }

        notifyChatMembers(io, created.chat);
        const result = joinChat(io, socket, account, created.chat.id);
        ack?.(result);
      },
    );

    socket.on(
      "group:invite",
      (
        payload: { groupId?: string; userId?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        if (!rateLimit(`group-invite:${account.userId}`, 30, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }

        const groupId = String(payload?.groupId || "");
        const targetUserId = String(payload?.userId || "");
        const group = getChat(groupId);
        if (!group || group.type !== "group") {
          ack?.({ ok: false, error: "Группа не найдена" });
          return;
        }
        if (!canAccessChat(group, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        if (!targetUserId || targetUserId === account.userId) {
          ack?.({ ok: false, error: "Укажите пользователя" });
          return;
        }
        if (!getUserById(targetUserId)) {
          ack?.({ ok: false, error: "Пользователь не найден" });
          return;
        }
        if (group.memberIds.includes(targetUserId)) {
          ack?.({ ok: false, error: "Уже в группе" });
          return;
        }

        const opened = openDm(account.userId, targetUserId);
        if (!opened.ok) {
          ack?.({ ok: false, error: opened.error });
          return;
        }

        const dm = opened.chat;
        const existingInvite = messagesFor(dm.id).find(
          (item) =>
            item.kind === "invite" &&
            item.invite?.groupId === groupId &&
            item.invite.status === "pending",
        );
        if (existingInvite) {
          ack?.({ ok: false, error: "Приглашение уже отправлено" });
          return;
        }

        const inviteMessage: ChatMessage = {
          id: randomUUID(),
          room: dm.id,
          author: labelOf(account),
          authorId: account.userId,
          text: `Приглашение в группу «${group.title}»`,
          createdAt: Date.now(),
          kind: "invite",
          invite: {
            groupId: group.id,
            groupTitle: group.title,
            status: "pending",
          },
        };
        pushMessage(io, dm, inviteMessage);
        notifyChatMembers(io, dm);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "group:invite:respond",
      (
        payload: {
          chatId?: string;
          messageId?: string;
          accept?: boolean;
        },
        ack?: (result: {
          ok: boolean;
          error?: string;
          groupId?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }

        const chatId = String(payload?.chatId || "");
        const messageId = String(payload?.messageId || "");
        const accept = Boolean(payload?.accept);
        const dm = getChat(chatId);
        if (!dm || dm.type !== "dm" || !canAccessChat(dm, account.userId)) {
          ack?.({ ok: false, error: "Чат не найден" });
          return;
        }

        const message = messagesFor(chatId).find((item) => item.id === messageId);
        if (!message || message.kind !== "invite" || !message.invite) {
          ack?.({ ok: false, error: "Приглашение не найдено" });
          return;
        }
        if (message.invite.status !== "pending") {
          ack?.({ ok: false, error: "Приглашение уже обработано" });
          return;
        }
        // Only the invitee (not the author) can respond.
        if (message.authorId === account.userId) {
          ack?.({ ok: false, error: "Это ваше приглашение" });
          return;
        }

        if (!accept) {
          message.invite = { ...message.invite, status: "declined" };
          message.text = `Отклонено: «${message.invite.groupTitle}»`;
          persistMessages();
          io.to(chatId).emit("message:update", publicMessage(message));
          notifyChatMembers(io, dm);
          ack?.({ ok: true });
          return;
        }

        const added = addGroupMember(message.invite.groupId, account.userId);
        if (!added.ok) {
          // Group may have been deleted while the invite was still pending.
          if (added.error === "Группа не найдена") {
            message.invite = { ...message.invite, status: "expired" };
            message.text = `Группа «${message.invite.groupTitle}» удалена`;
            persistMessages();
            io.to(chatId).emit("message:update", publicMessage(message));
            notifyChatMembers(io, dm);
            ack?.({ ok: false, error: "Группа удалена" });
            return;
          }
          ack?.({ ok: false, error: added.error });
          return;
        }

        message.invite = { ...message.invite, status: "accepted" };
        message.text = `Принято: «${message.invite.groupTitle}»`;
        persistMessages();
        io.to(chatId).emit("message:update", publicMessage(message));
        notifyChatMembers(io, dm);
        notifyChatMembers(io, added.chat);
        ack?.({ ok: true, groupId: added.chat.id });
      },
    );

    socket.on(
      "group:delete",
      (
        payload: { chatId?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }

        const chatId = String(payload?.chatId || "");
        if (!chatId) {
          ack?.({ ok: false, error: "Чат не указан" });
          return;
        }

        if (!rateLimit(`group-delete:${account.userId}`, 8, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }

        const existing = getChat(chatId);
        if (!existing) {
          ack?.({ ok: false, error: "Чат не найден" });
          return;
        }
        if (isProtectedChat(existing)) {
          ack?.({ ok: false, error: "Системные каналы удалить нельзя" });
          return;
        }

        const deleted = deleteGroup(chatId, account.userId);
        if (!deleted.ok) {
          ack?.({ ok: false, error: deleted.error });
          return;
        }

        expireInvitesForGroup(io, chatId, deleted.chat.title);
        // Tear down voice sessions in this group's channels so members'
        // clients close WebRTC before their sockets leave the chat.
        for (const channel of deleted.chat.voiceChannels || []) {
          const voiceRoom = voiceByChannel.get(channel.id);
          if (voiceRoom) {
            for (const member of voiceRoom.values()) {
              io.to(member.socketId).emit("voice:kick", {
                channelId: channel.id,
                reason: "channel-closed",
              });
            }
          }
          void deleteLiveKitRoom(channel.id);
          clearVoiceChannelPresence(channel.id);
        }
        clearChatMessages(chatId);
        io.to(chatId).emit("chat:deleted", { chatId });
        kickSocketsFromChat(io, chatId);

        // Refresh chat lists for former members (chat already removed).
        for (const memberId of deleted.chat.memberIds) {
          for (const socketId of socketsForUser(memberId)) {
            const memberSocket = io.sockets.sockets.get(socketId);
            if (memberSocket) emitChats(memberSocket, memberId);
          }
        }

        ack?.({ ok: true });
      },
    );

    socket.on(
      "group:avatar",
      (
        payload: { chatId?: string; avatarUrl?: string | null },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }

        const chatId = String(payload?.chatId || "");
        if (!chatId) {
          ack?.({ ok: false, error: "Чат не указан" });
          return;
        }

        if (!rateLimit(`group-avatar:${account.userId}`, 10, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }

        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }

        let avatarUrl = payload?.avatarUrl;
        if (typeof avatarUrl === "string" && avatarUrl) {
          avatarUrl = bareUploadUrl(avatarUrl);
          if (!isValidStoredAvatar(avatarUrl)) {
            ack?.({ ok: false, error: "Некорректный аватар" });
            return;
          }
        } else if (avatarUrl === null || avatarUrl === "") {
          avatarUrl = null;
        } else {
          ack?.({ ok: false, error: "Укажите аватар" });
          return;
        }

        const updated = updateGroupAvatar(chatId, account.userId, avatarUrl);
        if (!updated.ok) {
          ack?.({ ok: false, error: updated.error });
          return;
        }

        notifyChatMembers(io, updated.chat);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "group:update",
      (
        payload: { chatId?: string; title?: string; topic?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }

        const chatId = String(payload?.chatId || "");
        if (!chatId) {
          ack?.({ ok: false, error: "Чат не указан" });
          return;
        }

        if (!rateLimit(`group-update:${account.userId}`, 20, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }

        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }

        const patch: { title?: string; topic?: string } = {};
        if (typeof payload?.title === "string") patch.title = payload.title;
        if (typeof payload?.topic === "string") patch.topic = payload.topic;
        if (patch.title === undefined && patch.topic === undefined) {
          ack?.({ ok: false, error: "Нечего обновлять" });
          return;
        }

        const updated = updateGroupProfile(chatId, account.userId, patch);
        if (!updated.ok) {
          ack?.({ ok: false, error: updated.error });
          return;
        }

        notifyChatMembers(io, updated.chat);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "room:media",
      (
        payload: {
          chatId?: string;
          kind?: "media" | "file" | "all";
          limit?: number;
          offset?: number;
        },
        ack?: (result: {
          ok: boolean;
          items?: RoomMediaItem[];
          total?: number;
          hasMore?: boolean;
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }

        const chatId = String(payload?.chatId || "");
        if (!chatId) {
          ack?.({ ok: false, error: "Чат не указан" });
          return;
        }

        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }

        if (!rateLimit(`room-media:${account.userId}`, 40, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }

        const kind =
          payload?.kind === "media" || payload?.kind === "file"
            ? payload.kind
            : "all";
        const limit = Math.min(
          Math.max(Number(payload?.limit) || 48, 1),
          100,
        );
        const offset = Math.max(Number(payload?.offset) || 0, 0);
        const all = collectRoomMedia(chatId, kind);
        const items = all.slice(offset, offset + limit);
        ack?.({
          ok: true,
          items,
          total: all.length,
          hasMore: offset + limit < all.length,
        });
      },
    );

    socket.on(
      "chats:switch",
      (
        payload: { chatId?: string },
        ack?: (result: {
          ok: boolean;
          session?: { name: string; room: string };
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        const result = joinChat(
          io,
          socket,
          account,
          String(payload?.chatId || "lobby"),
        );
        ack?.(result);
      },
    );

    socket.on(
      "message",
      (
        payload: {
          text?: string;
          replyToId?: string;
          clientId?: string;
          chatId?: string;
        },
        ack?: (result: {
          ok: boolean;
          message?: ChatMessage;
          error?: string;
        }) => void,
      ) => {
        const presence = usersBySocket.get(socket.id);
        const account = requireAccount(socket);
        const text = String(payload?.text || "")
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
          .trim()
          .slice(0, 2000);
        if (!presence?.room || !account || !text) {
          ack?.({ ok: false, error: "Не удалось отправить" });
          return;
        }

        if (!rateLimit(`msg:${account.userId}`, 60, 60_000)) {
          ack?.({ ok: false, error: "Слишком много сообщений" });
          return;
        }

        const requestedChatId = String(payload?.chatId || "").trim();
        if (requestedChatId && requestedChatId !== presence.room) {
          ack?.({ ok: false, error: "Чат ещё открывается — подождите" });
          return;
        }

        const chat = getChat(presence.room);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }

        const { id, existing } = resolveClientMessageId(
          account.userId,
          String(payload?.clientId || ""),
          (messageId) =>
            messagesFor(presence.room!).find((item) => item.id === messageId),
        );
        if (existing) {
          ack?.({ ok: true, message: publicMessage(existing) });
          return;
        }

        const message: ChatMessage = {
          id,
          room: presence.room,
          author: labelOf(account),
          authorId: account.userId,
          text,
          createdAt: Date.now(),
          kind: "text",
          replyTo: resolveReply(presence.room, payload?.replyToId),
        };
        pushMessage(io, chat, message);
        socket.to(presence.room).emit("typing", {
          chatId: presence.room,
          name: labelOf(account),
          isTyping: false,
        });
        ack?.({ ok: true, message: publicMessage(message) });
      },
    );

    socket.on("chats:read", (payload: { chatId?: string }) => {
      const account = requireAccount(socket);
      const chatId = String(payload?.chatId || "");
      if (!account || !chatId) return;
      const chat = getChat(chatId);
      if (!chat || !canAccessChat(chat, account.userId)) return;
      const readAt = Date.now();
      markChatRead(account.userId, chatId);
      emitChats(socket, account.userId);
      // Real-time read receipt for peers in the room.
      socket.to(chatId).emit("chat:read", {
        chatId,
        userId: account.userId,
        readAt,
      });
    });

    socket.on(
      "chats:members",
      (
        payload: { chatId?: string },
        ack?: (result: {
          ok: boolean;
          members?: ReturnType<typeof listMemberProfiles>;
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        if (!account || !chatId) {
          ack?.({ ok: false, error: "Нет чата" });
          return;
        }
        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        const online = onlineUserIds();
        ack?.({
          ok: true,
          members: listMemberProfiles(chatId, account.userId, online).map(
            (member) => ({
              ...member,
              avatarUrl: member.avatarUrl
                ? signAvatarUrl(bareUploadUrl(member.avatarUrl))
                : undefined,
            }),
          ),
        });
      },
    );

    socket.on(
      "chats:pin",
      (
        payload: { chatId?: string },
        ack?: (result: { ok: boolean; pinned?: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        if (!account || !chatId) {
          ack?.({ ok: false, error: "Нет чата" });
          return;
        }
        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        const pinned = togglePinned(account.userId, chatId);
        emitChats(socket, account.userId);
        ack?.({ ok: true, pinned });
      },
    );

    socket.on(
      "message:react",
      (
        payload: { chatId?: string; messageId?: string; emoji?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        const messageId = String(payload?.messageId || "");
        const emoji = String(payload?.emoji || "");
        if (!account || !chatId || !messageId || !isAllowedReaction(emoji)) {
          ack?.({ ok: false, error: "Некорректная реакция" });
          return;
        }

        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }

        const message = messagesFor(chatId).find((item) => item.id === messageId);
        if (!message || message.kind === "system") {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }

        const updated = toggleReaction(message, account.userId, emoji);
        persistMessages();
        io.to(chatId).emit("message:update", publicMessage(updated));
        ack?.({ ok: true });
      },
    );

    socket.on(
      "message:delete",
      (
        payload: { chatId?: string; messageId?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        const messageId = String(payload?.messageId || "");
        if (!account || !chatId || !messageId) {
          ack?.({ ok: false, error: "Некорректный запрос" });
          return;
        }

        if (!rateLimit(`msg-del:${account.userId}`, 40, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }

        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }

        const message = messagesFor(chatId).find((item) => item.id === messageId);
        if (!message) {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }
        if (message.kind === "system") {
          ack?.({ ok: false, error: "Системные сообщения удалить нельзя" });
          return;
        }

        const isAuthor =
          message.authorId === account.userId ||
          (!message.authorId &&
            message.author.toLowerCase() === labelOf(account).toLowerCase());
        const isGroupOwner =
          chat.type === "group" &&
          Boolean(chat.createdBy) &&
          chat.createdBy === account.userId;

        if (!isAuthor && !isGroupOwner) {
          ack?.({ ok: false, error: "Можно удалять только свои сообщения" });
          return;
        }

        const redacted = redactMessage(chatId, messageId);
        if (!redacted) {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }

        io.to(chatId).emit("message:update", publicMessage(redacted.tombstone));
        for (const updated of redacted.replyUpdates) {
          io.to(chatId).emit("message:update", publicMessage(updated));
        }
        // Legacy clients still listening for hard-delete.
        io.to(chatId).emit("message:deleted", {
          chatId,
          messageId,
          tombstone: publicMessage(redacted.tombstone),
        });
        notifyChatMembers(io, chat);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "message:edit",
      (
        payload: { chatId?: string; messageId?: string; text?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        const messageId = String(payload?.messageId || "");
        const text = String(payload?.text || "").trim().slice(0, 4000);
        if (!account || !chatId || !messageId || !text) {
          ack?.({ ok: false, error: "Некорректный запрос" });
          return;
        }
        if (!rateLimit(`msg-edit:${account.userId}`, 60, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }
        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        const message = messagesFor(chatId).find((item) => item.id === messageId);
        if (!message || message.kind === "system" || message.kind === "call") {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }
        const isAuthor =
          message.authorId === account.userId ||
          (!message.authorId &&
            message.author.toLowerCase() === labelOf(account).toLowerCase());
        if (!isAuthor) {
          ack?.({ ok: false, error: "Можно править только свои сообщения" });
          return;
        }
        message.text = text;
        message.editedAt = Date.now();
        persistMessages();
        io.to(chatId).emit("message:update", publicMessage(message));
        notifyChatMembers(io, chat);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "message:pin",
      (
        payload: { chatId?: string; messageId?: string },
        ack?: (result: {
          ok: boolean;
          pinned?: boolean;
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        const messageId = String(payload?.messageId || "");
        if (!account || !chatId || !messageId) {
          ack?.({ ok: false, error: "Некорректный запрос" });
          return;
        }
        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        const list = messagesFor(chatId);
        const message = list.find((item) => item.id === messageId);
        if (!message || message.kind === "system") {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }
        const nextPinned = !message.pinned;
        const previouslyPinned = list.filter(
          (item) => item.pinned && item.id !== messageId,
        );
        for (const item of previouslyPinned) {
          item.pinned = false;
        }
        message.pinned = nextPinned;
        persistMessages();
        io.to(chatId).emit("message:update", publicMessage(message));
        for (const item of previouslyPinned) {
          io.to(chatId).emit("message:update", publicMessage(item));
        }
        ack?.({ ok: true, pinned: nextPinned });
      },
    );

    socket.on(
      "message:forward",
      (
        payload: {
          fromChatId?: string;
          messageId?: string;
          toChatId?: string;
        },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        const fromChatId = String(payload?.fromChatId || "");
        const toChatId = String(payload?.toChatId || "");
        const messageId = String(payload?.messageId || "");
        if (!account || !fromChatId || !toChatId || !messageId) {
          ack?.({ ok: false, error: "Некорректный запрос" });
          return;
        }
        if (!rateLimit(`msg-fwd:${account.userId}`, 40, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }
        const fromChat = getChat(fromChatId);
        const toChat = getChat(toChatId);
        if (
          !fromChat ||
          !toChat ||
          !canAccessChat(fromChat, account.userId) ||
          !canAccessChat(toChat, account.userId)
        ) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        const source = messagesFor(fromChatId).find((item) => item.id === messageId);
        if (!source || source.kind === "system" || source.kind === "call") {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }
        if (source.kind === "invite") {
          ack?.({ ok: false, error: "Приглашение нельзя переслать" });
          return;
        }
        const message: ChatMessage = {
          id: randomUUID(),
          room: toChatId,
          author: labelOf(account),
          authorId: account.userId,
          text: source.text || "",
          createdAt: Date.now(),
          kind: source.kind || "text",
          file: source.file,
          files: source.files,
          forwardedFrom: {
            author: source.author,
            text: source.text?.slice(0, 120),
          },
        };
        pushMessage(io, toChat, message);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "message:file",
      (
        payload: {
          chatId?: string;
          file?: { url?: string; name?: string; size?: number; mime?: string };
          files?: { url?: string; name?: string; size?: number; mime?: string }[];
          text?: string;
          replyToId?: string;
        },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const presence = usersBySocket.get(socket.id);
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Нужен вход" });
          return;
        }

        if (!rateLimit(`msg:${account.userId}`, 60, 60_000)) {
          ack?.({ ok: false, error: "Слишком много сообщений" });
          return;
        }

        const chatId = String(payload?.chatId || presence?.room || "");
        if (!chatId || !presence?.room || presence.room !== chatId) {
          ack?.({ ok: false, error: "Нет активного чата" });
          return;
        }

        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }

        const rawList =
          Array.isArray(payload?.files) && payload.files.length
            ? payload.files
            : payload?.file
              ? [payload.file]
              : [];
        if (!rawList.length || rawList.length > 10) {
          ack?.({
            ok: false,
            error: rawList.length > 10 ? "Слишком много файлов" : "Файл не передан",
          });
          return;
        }

        const resolved: {
          url: string;
          name: string;
          size: number;
          mime: string;
          isAudio: boolean;
        }[] = [];

        for (const file of rawList) {
          const url = String(file?.url || "");
          const diskPath = uploadPathFromUrl(url);
          if (!file?.name || !diskPath) {
            ack?.({ ok: false, error: "Файл не передан" });
            return;
          }

          const safeFileName = String(file.name)
            .replace(/[\u0000-\u001F\u007F]/g, "")
            .slice(0, 120);
          const clientMime = String(file.mime || "")
            .split(";")[0]
            .trim()
            .toLowerCase();
          const fromName = mimeFromName(diskPath);
          const isAudio =
            clientMime.startsWith("audio/") ||
            /^voice[-_]/i.test(safeFileName) ||
            /\.(mp3|wav|m4a|aac|ogg|opus|flac|weba)$/i.test(safeFileName) ||
            (/\.webm$/i.test(safeFileName) && !clientMime.startsWith("video/"));
          const serverMime = isAudio
            ? clientMime.startsWith("audio/")
              ? clientMime
              : /\.m4a$/i.test(safeFileName) || /\.aac$/i.test(safeFileName)
                ? "audio/mp4"
                : /\.(ogg|opus)$/i.test(safeFileName)
                  ? "audio/ogg"
                  : /\.mp3$/i.test(safeFileName)
                    ? "audio/mpeg"
                    : /\.wav$/i.test(safeFileName)
                      ? "audio/wav"
                      : "audio/webm"
            : fromName;
          if (
            isBlockedUpload(safeFileName, serverMime) ||
            isBlockedUpload(diskPath, serverMime)
          ) {
            ack?.({ ok: false, error: "Этот тип файла запрещён" });
            return;
          }
          if (!uploadOwnedBy(url, account.userId)) {
            ack?.({ ok: false, error: "Файл вам не принадлежит" });
            return;
          }

          let size = Number(file.size) || 0;
          try {
            size = statSync(diskPath).size;
          } catch {
            ack?.({ ok: false, error: "Файл не найден на сервере" });
            return;
          }

          resolved.push({
            url: bareUploadUrl(url),
            name: safeFileName,
            size,
            mime: serverMime,
            isAudio,
          });
        }

        const albumMedia =
          resolved.length > 1 &&
          resolved.every((item) =>
            isImageAttachment(item) || isVideoAttachment(item),
          );
        if (resolved.length > 1 && !albumMedia) {
          ack?.({
            ok: false,
            error: "В одном сообщении можно объединять только фото и видео",
          });
          return;
        }

        const first = resolved[0];
        const rawText = String(payload?.text || "").trim();
        const text = albumMedia
          ? rawText
          : first.isAudio
            ? rawText &&
              rawText !== first.name &&
              rawText !== "Голосовое сообщение" &&
              rawText !== "Аудио"
              ? rawText
              : /^voice[-_]/i.test(first.name)
                ? "Голосовое сообщение"
                : "Аудио"
            : isImageAttachment(first) || isVideoAttachment(first)
              ? rawText
              : rawText || first.name;

        const attachments = resolved.map(({ url, name, size, mime }) => ({
          url,
          name,
          size,
          mime,
        }));

        pushMessage(io, chat, {
          id: randomUUID(),
          room: chatId,
          author: labelOf(account),
          authorId: account.userId,
          text: text.slice(0, 200),
          createdAt: Date.now(),
          kind: "file",
          file: attachments[0],
          files: attachments.length > 1 ? attachments : undefined,
          replyTo: resolveReply(chatId, payload?.replyToId),
        });
        ack?.({ ok: true });
      },
    );

    socket.on("typing", (isTyping: boolean) => {
      const account = requireAccount(socket);
      const presence = usersBySocket.get(socket.id);
      if (!account || !presence?.room) return;
      if (!rateLimit(`typing:${account.userId}`, 30, 10_000)) return;
      socket.to(presence.room).emit("typing", {
        chatId: presence.room,
        name: presence.name,
        isTyping: Boolean(isTyping),
      });
    });

    socket.on(
      "call:invite",
      (
        payload: {
          toUserId?: string;
          mode?: "audio" | "video";
          chatId?: string;
          reconnect?: boolean;
        },
        ack?: (result: {
          ok: boolean;
          callId?: string;
          resume?: boolean;
          role?: "caller" | "callee";
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Нужен вход" });
          return;
        }

        if (!rateLimit(`call-invite:${account.userId}`, 8, 60_000)) {
          ack?.({ ok: false, error: "Слишком много звонков" });
          return;
        }

        const toUserId = String(payload?.toUserId || "");
        const mode = payload?.mode === "video" ? "video" : "audio";
        const chatId = String(payload?.chatId || "");
        const reconnect = Boolean(payload?.reconnect);
        if (!getUserById(toUserId)) {
          ack?.({ ok: false, error: "Пользователь не найден" });
          return;
        }
        const onlineSockets = socketsForUser(toUserId);
        const canReachPush = hasPushSubscription(toUserId);
        if (!onlineSockets.length && !canReachPush) {
          ack?.({ ok: false, error: "Собеседник не в сети" });
          return;
        }
        const chat = getChat(chatId);
        if (
          !chat ||
          !canAccessChat(chat, account.userId) ||
          !canAccessChat(chat, toUserId) ||
          chat.type !== "dm" ||
          peerIdForViewer(chat, account.userId) !== toUserId
        ) {
          ack?.({ ok: false, error: "Нет доступа к чату" });
          return;
        }
        const existingPair = getCallForUsers(account.userId, toUserId);
        if (existingPair) {
          const canResume =
            reconnect &&
            existingPair.status === "active" &&
            userIsConnected(toUserId);
          if (
            reconnect &&
            existingPair.status === "active" &&
            !userIsConnected(toUserId)
          ) {
            ack?.({ ok: false, error: "Собеседник не в сети" });
            return;
          }
          if (canResume) {
            cancelCallDisconnectTimer(account.userId);
            callByUser.set(account.userId, existingPair.callId);
            ack?.({
              ok: true,
              callId: existingPair.callId,
              resume: true,
              role: existingPair.callerId === account.userId ? "caller" : "callee",
            });
            emitToUser(io, toUserId, "call:renegotiate", {
              callId: existingPair.callId,
              fromUserId: account.userId,
              fromName: labelOf(account),
              mode: existingPair.mode,
              chatId: existingPair.chatId,
            });
            return;
          }
          clearCall(existingPair.callId);
        }
        releaseBusyUserIfZombie(account.userId);
        releaseBusyUserIfZombie(toUserId);
        if (isCallBusy(account.userId) || isCallBusy(toUserId)) {
          ack?.({ ok: false, error: "Линия занята" });
          return;
        }
        if (voiceByUser.has(account.userId) || voiceByUser.has(toUserId)) {
          ack?.({ ok: false, error: "Сначала выйдите из голосового канала" });
          return;
        }

        const callId = randomUUID();
        const call: CallRecord = {
          callId,
          callerId: account.userId,
          calleeId: toUserId,
          mode,
          chatId,
          status: "ringing",
          createdAt: Date.now(),
          timer: setTimeout(() => {
            const current = callsById.get(callId);
            if (!current || current.status !== "ringing") return;
            clearCall(callId);
            allowCallLog(account.userId, chatId);
            allowCallLog(toUserId, chatId);
            emitToUser(io, account.userId, "call:signal", {
              callId,
              fromUserId: toUserId,
              fromName: "Pulse",
              type: "end",
              data: { reason: "timeout" },
            });
            emitToUser(io, toUserId, "call:signal", {
              callId,
              fromUserId: account.userId,
              fromName: labelOf(account),
              type: "end",
              data: { reason: "timeout" },
            });
          }, RING_TIMEOUT_MS),
        };

        callsById.set(callId, call);
        callByUser.set(account.userId, callId);
        callByUser.set(toUserId, callId);
        persistLiveMedia();
        allowCallLog(account.userId, chatId);
        allowCallLog(toUserId, chatId);

        emitToUser(io, toUserId, "call:incoming", {
          callId,
          fromUserId: account.userId,
          fromName: labelOf(account),
          mode,
          chatId,
          reconnect,
        });
        if (!reconnect) {
          // Wake suspended mobile tabs via Web Push (OS notification + ringtone).
          void sendPushToUser(toUserId, {
            title: "Входящий звонок",
            body: `${labelOf(account)} звонит вам`,
            chatId,
            callId,
            kind: "call",
            tag: `pulse-call-${callId}`,
          });
        }
        ack?.({ ok: true, callId });
      },
    );

    socket.on(
      "call:signal",
      (payload: {
        callId?: string;
        toUserId?: string;
        type?:
          | "offer"
          | "answer"
          | "ice"
          | "accept"
          | "reject"
          | "end"
          | "peer-left"
          | "screen-on"
          | "screen-off"
          | "camera-on"
          | "camera-off"
          | "media-request"
          | "media-state";
        data?: unknown;
      }) => {
        const account = requireAccount(socket);
        const toUserId = String(payload?.toUserId || "");
        const callId = String(payload?.callId || "");
        if (!account || !toUserId || !payload?.type || !callId) return;

        const mediaControl =
          payload.type === "screen-on" ||
          payload.type === "screen-off" ||
          payload.type === "camera-on" ||
          payload.type === "camera-off" ||
          payload.type === "media-request" ||
          payload.type === "media-state";
        const signalKey = mediaControl ? "call-media" : "call-signal";
        const signalLimit = mediaControl ? 90 : 240;
        if (!rateLimit(`${signalKey}:${account.userId}`, signalLimit, 60_000)) {
          return;
        }

        const call = callsById.get(callId);
        if (!call) return;

        const participants = new Set([call.callerId, call.calleeId]);
        if (!participants.has(account.userId) || !participants.has(toUserId)) {
          return;
        }

        if (payload.type === "accept") {
          if (account.userId !== call.calleeId) {
            return;
          }
          if (call.status === "ringing") {
            if (call.timer) {
              clearTimeout(call.timer);
              call.timer = null;
            }
            call.status = "active";
            persistLiveMedia();
          }
          // Stop ringing on the callee's other tabs — not this socket.
          for (const socketId of socketsForUser(account.userId)) {
            if (socketId === socket.id) continue;
            io.to(socketId).emit("call:dismiss", { callId });
          }
        }

        if (payload.type === "reject") {
          allowCallLog(call.callerId, call.chatId);
          allowCallLog(call.calleeId, call.chatId);
          clearCall(callId);
          emitToUser(io, account.userId, "call:dismiss", { callId });
          emitToUser(io, toUserId, "call:signal", {
            callId,
            fromUserId: account.userId,
            fromName: labelOf(account),
            type: "reject",
          });
          return;
        }

        if (payload.type === "end") {
          allowCallLog(call.callerId, call.chatId);
          allowCallLog(call.calleeId, call.chatId);
          const ringing = call.status === "ringing";
          const remainingId = leaveCallParticipant(call, account.userId);
          if (remainingId) {
            emitToUser(io, remainingId, "call:signal", {
              callId,
              fromUserId: account.userId,
              fromName: labelOf(account),
              type: ringing ? "end" : "peer-left",
              data: { reason: "hangup" },
            });
          }
          return;
        }

        const controlOnly = payload.type === "accept";
        let data: unknown = controlOnly ? undefined : payload.data;
        if (data !== undefined) {
          try {
            const raw = JSON.stringify(data);
            if (!raw || raw.length > CALL_SIGNAL_MAX_JSON) {
              data = undefined;
            }
          } catch {
            data = undefined;
          }
        }

        emitToUser(io, toUserId, "call:signal", {
          callId,
          fromUserId: account.userId,
          fromName: labelOf(account),
          type: payload.type,
          data,
        });
      },
    );

    socket.on(
      "call:log",
      (payload: { chatId?: string; text?: string }) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        const text = String(payload?.text || "").slice(0, 120);
        if (!account || !chatId || !text) return;
        if (!CALL_LOG_RE.test(text)) return;
        if (!canCallLog(account.userId, chatId)) return;
        if (!rateLimit(`call-log:${account.userId}`, 20, 60_000)) return;
        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId) || chat.type !== "dm") {
          return;
        }
        pushMessage(io, chat, {
          id: randomUUID(),
          room: chatId,
          author: labelOf(account),
          authorId: account.userId,
          text,
          createdAt: Date.now(),
          kind: "call",
        });
      },
    );

    socket.on("leave", () => {
      leaveCurrentRoom(io, socket);
      broadcastPeople(io);
    });

    socket.on(
      "voice:create",
      (
        payload: { groupId?: string; title?: string },
        ack?: (result: {
          ok: boolean;
          channel?: { id: string; title: string };
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        if (!rateLimit(`voice-create:${account.userId}`, 20, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }
        const created = createVoiceChannel(
          String(payload?.groupId || ""),
          account.userId,
          String(payload?.title || ""),
        );
        if (!created.ok) {
          ack?.({ ok: false, error: created.error });
          return;
        }
        emitVoiceState(io, created.chat);
        notifyChatMembers(io, created.chat);
        ack?.({
          ok: true,
          channel: { id: created.channel.id, title: created.channel.title },
        });
      },
    );

    socket.on(
      "voice:delete",
      (
        payload: { groupId?: string; channelId?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        const groupId = String(payload?.groupId || "");
        const channelId = String(payload?.channelId || "");
        if (!groupId || !channelId) {
          ack?.({ ok: false, error: "Канал не найден" });
          return;
        }
        const deleted = deleteVoiceChannel(groupId, channelId, account.userId);
        if (!deleted.ok) {
          ack?.({ ok: false, error: deleted.error });
          return;
        }
        void deleteLiveKitRoom(channelId);
        clearVoiceChannelPresence(channelId);
        emitVoiceState(io, deleted.chat);
        notifyChatMembers(io, deleted.chat);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "voice:join",
      (
        payload: { channelId?: string },
        ack?: (result: {
          ok: boolean;
          channelId?: string;
          groupId?: string;
          peers?: ReturnType<typeof voiceUsersForChannel>;
          topology?: VoiceTopology;
          topologyEpoch?: number;
          error?: string;
        }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите в аккаунт" });
          return;
        }
        if (callByUser.has(account.userId)) {
          ack?.({ ok: false, error: "Сначала завершите звонок" });
          return;
        }
        const channelId = String(payload?.channelId || "");
        const found = findVoiceChannel(channelId);
        if (!found || !canAccessChat(found.group, account.userId)) {
          ack?.({ ok: false, error: "Канал не найден" });
          return;
        }

        const reconnectTimer = voiceDisconnectTimers.get(account.userId);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        voiceDisconnectTimers.delete(account.userId);

        // Soft-rebind after a Socket.IO reconnect: keep the LiveKit media
        // session alive and only refresh presence ownership.
        const existingChannelId = voiceByUser.get(account.userId);
        const existingMember = existingChannelId
          ? voiceByChannel.get(existingChannelId)?.get(account.userId)
          : undefined;
        if (existingChannelId === channelId && existingMember) {
          const staleSocketAlive =
            existingMember.socketId !== socket.id &&
            Boolean(io.sockets.sockets.get(existingMember.socketId));
          if (!staleSocketAlive) {
            if (existingMember.socketId !== socket.id) {
              voiceBySocket.delete(existingMember.socketId);
              existingMember.socketId = socket.id;
            }
            voiceBySocket.set(socket.id, channelId);
            voiceByUser.set(account.userId, channelId);
            voiceByChannel.get(channelId)?.set(account.userId, existingMember);
            const topo = voiceTopologyInfo(channelId);
            emitVoiceState(io, found.group);
            ack?.({
              ok: true,
              channelId,
              groupId: found.group.id,
              peers: voiceUsersForChannel(channelId).filter(
                (peer) => peer.userId !== account.userId,
              ),
              topology: topo.topology,
              topologyEpoch: topo.topologyEpoch,
            });
            return;
          }
        }

        leaveVoiceChannel(io, socket, account.userId);

        // The same account may still own presence from another tab:
        // leaveVoiceChannel refuses to drop it, so take over explicitly and
        // tell the stale tab to tear down its WebRTC session.
        const takenChannelId = voiceByUser.get(account.userId);
        if (takenChannelId) {
          const staleRoom = voiceByChannel.get(takenChannelId);
          const staleMember = staleRoom?.get(account.userId);
          if (staleRoom && staleMember && staleMember.socketId !== socket.id) {
            const takenPrevSize = staleRoom.size;
            staleRoom.delete(account.userId);
            if (staleRoom.size === 0) voiceByChannel.delete(takenChannelId);
            voiceByUser.delete(account.userId);
            voiceBySocket.delete(staleMember.socketId);
            void removeLiveKitParticipant(takenChannelId, account.userId);
            maybeBumpVoiceTopology(takenChannelId, takenPrevSize);
            io.to(staleMember.socketId).emit("voice:kick", {
              channelId: takenChannelId,
              reason: "takeover",
            });
            const staleFound = findVoiceChannel(takenChannelId);
            if (staleFound) emitVoiceState(io, staleFound.group);
          }
        }

        let room = voiceByChannel.get(channelId);
        if (!room) {
          room = new Map();
          voiceByChannel.set(channelId, room);
        }
        if (room.size >= 12) {
          ack?.({ ok: false, error: "Канал заполнен" });
          return;
        }

        const previousSize = room.size;
        const peers = voiceUsersForChannel(channelId);
        const stored = getUserById(account.userId);
        const member: VoiceMember = {
          userId: account.userId,
          name: labelOf(account),
          muted: false,
          deafened: false,
          speaking: false,
          cameraOff: true,
          sharingScreen: false,
          mediaRevision: 0,
          avatarUrl: stored?.avatarUrl || account.avatarUrl,
          socketId: socket.id,
        };
        room.set(account.userId, member);
        voiceByUser.set(account.userId, channelId);
        voiceBySocket.set(socket.id, channelId);
        const topo = maybeBumpVoiceTopology(channelId, previousSize);
        persistLiveMedia();
        emitVoiceState(io, found.group);
        ack?.({
          ok: true,
          channelId,
          groupId: found.group.id,
          peers,
          topology: topo.topology,
          topologyEpoch: topo.topologyEpoch,
        });
      },
    );

    socket.on(
      "voice:leave",
      (
        _payload?: unknown,
        ack?: (result: { ok: boolean }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false });
          return;
        }
        leaveVoiceChannel(io, socket, account.userId);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "voice:mute",
      (
        payload: { muted?: boolean },
        ack?: (result: { ok: boolean }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false });
          return;
        }
        const channelId = voiceByUser.get(account.userId);
        if (!channelId) {
          ack?.({ ok: false });
          return;
        }
        const room = voiceByChannel.get(channelId);
        const member = room?.get(account.userId);
        if (!member || member.socketId !== socket.id) {
          ack?.({ ok: false });
          return;
        }
        member.muted = Boolean(payload?.muted);
        if (member.muted) member.speaking = false;
        room?.set(account.userId, member);
        const found = findVoiceChannel(channelId);
        if (found) emitVoiceState(io, found.group);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "voice:deafen",
      (
        payload: { deafened?: boolean },
        ack?: (result: { ok: boolean }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false });
          return;
        }
        const channelId = voiceByUser.get(account.userId);
        if (!channelId) {
          ack?.({ ok: false });
          return;
        }
        const room = voiceByChannel.get(channelId);
        const member = room?.get(account.userId);
        if (!member || member.socketId !== socket.id) {
          ack?.({ ok: false });
          return;
        }
        member.deafened = Boolean(payload?.deafened);
        if (member.deafened) {
          member.muted = true;
          member.speaking = false;
        }
        room?.set(account.userId, member);
        const found = findVoiceChannel(channelId);
        if (found) emitVoiceState(io, found.group);
        ack?.({ ok: true });
      },
    );

    socket.on(
      "voice:speaking",
      (payload: { speaking?: boolean }) => {
        const account = requireAccount(socket);
        if (!account) return;
        const channelId = voiceByUser.get(account.userId);
        if (!channelId) return;
        const room = voiceByChannel.get(channelId);
        const member = room?.get(account.userId);
        if (!member || member.socketId !== socket.id) return;
        const speaking = Boolean(payload?.speaking) && !member.muted;
        if (member.speaking === speaking) return;
        member.speaking = speaking;
        room?.set(account.userId, member);
        const found = findVoiceChannel(channelId);
        if (found) emitVoiceState(io, found.group);
      },
    );

    socket.on(
      "voice:media",
      (
        payload: { cameraOff?: boolean; sharingScreen?: boolean },
        ack?: (result: { ok: boolean }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) {
          ack?.({ ok: false });
          return;
        }
        const channelId = voiceByUser.get(account.userId);
        if (!channelId) {
          ack?.({ ok: false });
          return;
        }
        const room = voiceByChannel.get(channelId);
        const member = room?.get(account.userId);
        if (!member || member.socketId !== socket.id) {
          ack?.({ ok: false });
          return;
        }
        let supplied = false;
        let changed = false;
        if (typeof payload?.cameraOff === "boolean") {
          supplied = true;
          if (member.cameraOff !== payload.cameraOff) {
            member.cameraOff = payload.cameraOff;
            changed = true;
          }
        }
        if (typeof payload?.sharingScreen === "boolean") {
          supplied = true;
          if (member.sharingScreen !== payload.sharingScreen) {
            member.sharingScreen = payload.sharingScreen;
            changed = true;
          }
        }
        if (!supplied) {
          ack?.({ ok: false });
          return;
        }
        if (changed) member.mediaRevision += 1;
        room?.set(account.userId, member);
        const mediaState = {
          channelId,
          userId: account.userId,
          cameraOff: member.cameraOff,
          sharingScreen: member.sharingScreen,
          mediaRevision: member.mediaRevision,
        };
        for (const voiceMember of room?.values() || []) {
          io.to(voiceMember.socketId).emit("voice:media", mediaState);
        }
        if (changed) {
          const found = findVoiceChannel(channelId);
          if (found) emitVoiceState(io, found.group);
        }
        ack?.({ ok: true });
      },
    );

    socket.on("voice:signal", () => {
      // Group channels are always LiveKit SFU. Mesh signaling is never relayed.
    });

    socket.on("disconnect", () => {
      const account = requireAccount(socket);
      if (account) {
        const voiceChannelId = voiceBySocket.get(socket.id);
        if (voiceChannelId) {
          const existingVoiceTimer = voiceDisconnectTimers.get(account.userId);
          if (existingVoiceTimer) clearTimeout(existingVoiceTimer);
          voiceDisconnectTimers.set(
            account.userId,
            setTimeout(() => {
              voiceDisconnectTimers.delete(account.userId);
              if (voiceBySocket.get(socket.id) !== voiceChannelId) return;
              leaveVoiceChannel(io, socket, account.userId);
            }, VOICE_RECONNECT_GRACE_MS),
          );
        }
        const remaining = socketsForUser(account.userId).filter(
          (id) => id !== socket.id,
        );
        if (remaining.length === 0) {
          const callId = callByUser.get(account.userId);
          const call = callId ? callsById.get(callId) : null;
          if (call) {
            const existingTimer = callDisconnectTimers.get(account.userId);
            if (existingTimer) clearTimeout(existingTimer);
            callDisconnectTimers.set(
              account.userId,
              setTimeout(() => {
                callDisconnectTimers.delete(account.userId);
                if (socketsForUser(account.userId).length > 0) return;
                const still = callsById.get(call.callId);
                if (!still) return;
                allowCallLog(account.userId, still.chatId);
                allowCallLog(peerIdOfCall(still, account.userId), still.chatId);
                const ringing = still.status === "ringing";
                const remainingId = leaveCallParticipant(still, account.userId);
                if (!remainingId) return;
                emitToUser(io, remainingId, "call:signal", {
                  callId: still.callId,
                  fromUserId: account.userId,
                  fromName: labelOf(account),
                  type: ringing ? "end" : "peer-left",
                  data: { reason: "disconnect" },
                });
              }, CALL_RECONNECT_GRACE_MS),
            );
          }
        }
        touchLastSeen(account.userId);
      }
      leaveCurrentRoom(io, socket);
      usersBySocket.delete(socket.id);
      unbindSocketAuth(socket.id);
      broadcastPeople(io);
    });
  });

  const previousUpgrade = httpServer.listeners("upgrade").slice() as ((
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void)[];
  httpServer.removeAllListeners("upgrade");
  httpServer.on("upgrade", (req, socket, head) => {
    if ((req.url || "").startsWith("/livekit")) {
      proxyLiveKitUpgrade(req, socket, head);
      return;
    }
    for (const listener of previousUpgrade) {
      listener.call(httpServer, req, socket, head);
    }
  });

  httpServer.listen(port, hostname, () => {
    console.log(`> Pulse Chat ready on http://${hostname}:${port}`);
    console.log(`> Local  http://127.0.0.1:${port}`);
    for (const ip of lanIPv4Addresses()) {
      console.log(`> LAN    http://${ip}:${port}`);
    }
    if (publicOrigin) console.log(`> Public origin ${publicOrigin}`);
  });

  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        flushAllPersists();
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    // Wait for in-flight persister writes so the final sync flush cannot
    // race them on the same temp files, but never hang shutdown on it.
    Promise.all(
      [persistMessages, persistReads, persistPins, persistLiveMedia].map((p) =>
        p.idle(),
      ),
    ).then(finish, finish);
    setTimeout(finish, 3_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", () => {
    try {
      flushAllPersists();
    } catch {
      /* ignore */
    }
  });
});
