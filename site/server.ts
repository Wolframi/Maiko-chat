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
} from "node:fs";
import path from "node:path";
import { parse } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import next from "next";
import { loadEnvConfig } from "@next/env";
import { MessageStore } from "./src/server/messageStore";
import { MessageTasks } from "./src/server/messageTasks";
import { hideHistoryFor, messageVisibleTo } from "./src/server/dmHistory";
import { summarizeMessages } from "./src/server/messageSummary";
import { selectHistoryPage, isThreadMessage } from "./src/server/historyPage";
import { selectHistoryWindow, selectNewerHistory, searchHistory } from "./src/server/historyNavigation";
import { personSearchScore } from "./src/lib/username";
import { canManageRegistration, memberRegistrationInvite, registrationPolicy, setRegistrationPolicy } from "./src/server/registrationInvites";
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
  authCredentialsError,
  normalizeUsername,
  logoutToken,
  registerUser,
  restoreSession,
  touchLastSeen,
  unbindSocketAuth,
  updateProfile,
  onSessionRevoked,
  socketIdsForToken,
  ensureDemoUsers,
  recordSessionAccess,
  listDeviceSessions,
  revokeDeviceSession,
  revokeOtherDeviceSessions,
  type AuthAccount,
} from "./src/server/auth";
import {
  canAccessChat,
  createGroup,
  createVoiceChannel,
  createTextChannel,
  deleteVoiceChannel,
  deleteTextChannel,
  messageRoomFor,
  addGroupMember,
  dmTitleForViewer,
  ensureVoiceChannels,
  findVoiceChannel,
  getChat,
  findGroupByTitle,
  groupVisibility,
  joinPublicGroup,
  getGroupInviteCode,
  joinGroupByCode,
  listChatsForUser,
  listMemberProfiles,
  openDm,
  hideDm,
  peerIdForViewer,
  searchPublicGroups,
  updateGroupAvatar,
  updateGroupProfile,
  updateGroupVisibility,
  deleteGroup,
  leaveGroup,
  removeMemberEverywhere,
  isProtectedChat,
  type ChatMeta,
  type VoiceChannelMeta,
} from "./src/server/chats";
import {
  addSticker as addStickerToPack,  canSendSticker,
  createPack as createStickerPack,
  deletePack as deleteStickerPack,
  findSticker,
  getPack as getStickerPack,
  installPack as installStickerPack,
  listPacksForUser,
  removeSticker as removeStickerFromPack,
  uninstallPack as uninstallStickerPack,
  updatePackTitle,
} from "./src/server/stickers";
import {
  botAdminSecret,
  botProfileMeta,
  createBot,
  findBot,
  findBotByUsername,
  isBotUserId,
  listBots,
  markBotConnected,
  publicBot,
  removeBot,
  resolveBotToken,
  rotateBotToken,
  setBotCommands,
  setBotDescription,
  setBotDisplayName,
  verifyBotAdminSecret,
} from "./src/server/bots";
import {
  BOT_MAX_CAPTION,
  BOT_MAX_FILES,
  BOT_MAX_TEXT,
  normalizeBotButtons,
  parseBotCommand,
  sanitizeBotText,
} from "./src/server/botProtocol";
import {
  handleUpload,
  tryServeUpload,
  getUploadInfo,
  getUploadMicroPreview,
  withUploadFile,
  mimeFromName,
  isValidStoredAvatar,
  uploadOwnedBy,
  signUploadUrl,
  signAvatarUrl,
  bareUploadUrl,
  sweepOrphanUploads,
} from "./src/server/uploads";
import { handleRingtones } from "./src/server/ringtones";
import { tryServeDesktopUpdate } from "./src/server/desktopUpdates";
import { configureDesktopUpdateNotifications } from "./src/server/desktopUpdateNotifications";
import { s3Enabled, s3Origin } from "./src/server/objectStorage";
import { rateLimit } from "./src/server/rateLimit";
import { clientAddress } from "./src/server/requestSecurity";
import { issueTurnCredentials } from "./src/server/turnCredentials";
import { MessageAdmission } from "./src/server/messageAdmission";
import { monitorSocketBackpressure, isSocketBackedUp } from "./src/server/socketBackpressure";
import { isAllowedPushEndpoint, validPushKeys } from "./src/server/pushSecurity";
import { getGifs } from "./src/server/gif";
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
  chatListPreview,
  isAudioAttachment,
  isImageAttachment,
  isVideoAttachment,
  isVoiceNote,
  messageAttachments,
  parseMediaSize,
  isGifAttachment,
} from "./src/lib/files";
import {
  hasTranscriptionKey,
  queueTranscription,
  transcribeAudioFile,
} from "./src/server/transcribe";
import { parseGiphyMediaUrl } from "./src/lib/giphyMedia";
import { validMicroPreview } from "./src/lib/microPreview";
import type { BotButton, RoomMediaItem } from "./src/lib/types";
import {
  isDevAccessibleHost,
  lanIPv4Addresses,
  listenHostname,
} from "./src/lib/devHosts";

loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== "production";
const hostname = listenHostname();
const port = Number(process.env.PORT) || 3000;


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
  // Group channels always use the LiveKit on this VM (livekit-server --dev
  // locally, systemd livekit on the VPS). Never return empty keys — that left clients
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
  /** Server-only visibility: deleting a DM for oneself keeps the peer's copy. */
  hiddenFor?: string[];
  id: string;
  room: string;
  author: string;
  authorId?: string;
  /** Sender-generated idempotency key — survives server restarts. */
  clientId?: string;
  text: string;
  createdAt: number;
  editedAt?: number;
  pinned?: boolean;
  kind?: "text" | "system" | "file" | "call" | "invite" | "sticker";
  file?: {
    url: string;
    name: string;
    size: number;
    mime: string;
    width?: number;
    height?: number;
  };
  files?: {
    url: string;
    name: string;
    size: number;
    mime: string;
    width?: number;
    height?: number;
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
  sticker?: {
    packId: string;
    stickerId: string;
    url: string;
    animated?: boolean;
    width?: number;
    height?: number;
  };
  /** Inline keyboard rows; only bot messages carry them. */
  buttons?: BotButton[][];
  reactions?: MessageReaction[];
  transcription?: string;
  transcriptionStatus?: "pending" | "ready" | "error";
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
/** Socket.IO server — set in app.prepare().then, used by the ghost-call sweep. */
let ioServer: Server | null = null;
const callByUser = new Map<string, string>();
const callDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RING_TIMEOUT_MS = 45_000;
const CALL_RECONNECT_GRACE_MS = 25_000;
const APP_BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// Read once: a build in progress must not advertise itself before PM2 starts it.
const APP_BUILD_ID = dev ? APP_BOOT_ID : readFileSync(path.join(process.cwd(), ".next/BUILD_ID"), "utf8").trim();
const DEPLOY_RECONNECT_GRACE_MS = 90_000;
const restoredMediaUntil = Date.now() + DEPLOY_RECONNECT_GRACE_MS;
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
const messageStore = process.env.MONGODB_URI
  ? new MessageStore<ChatMessage>(process.env.MONGODB_URI, process.env.MONGODB_DATABASE)
  : undefined;
const messageTasks = new MessageTasks();
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

function storedMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.sticker?.url ? { sticker: { ...message.sticker, url: bareUploadUrl(message.sticker.url) } } : {}),
    ...(message.file?.url ? { file: { ...message.file, url: bareUploadUrl(message.file.url) } } : {}),
    ...(message.files?.length ? { files: message.files.map(file => ({ ...file, url: bareUploadUrl(file.url) })) } : {}),
  };
}

function writeMessagesSnapshot() {
  const payload: Record<string, ChatMessage[]> = {};
  for (const [chatId, list] of chatMessages) {
    payload[chatId] = list.map(storedMessage);
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

const persistJsonMessages = createPersister(writeMessagesSnapshot);
const persistMessages = Object.assign((changed: readonly ChatMessage[]) => {
  if (messageStore) {
    for (const message of changed) messageStore.update(storedMessage(message));
  } else persistJsonMessages();
}, { idle: () => messageStore ? messageStore.idle() : persistJsonMessages.idle() });

function persistNewMessage(message: ChatMessage) {
  if (messageStore) messageStore.append(storedMessage(message));
  else persistJsonMessages();
}
const persistReads = createPersister(writeReadsSnapshot);
const persistPins = createPersister(writePinsSnapshot);
const persistLiveMedia = createPersister(writeLiveMediaSnapshot);

function flushAllPersists() {
  if (!messageStore) writeMessagesSnapshot();
  writeReadsSnapshot();
  writePinsSnapshot();
  writeLiveMediaSnapshot();
}

function loadPersistedState() {
  try {
    if (!messageStore && existsSync(MESSAGES_FILE)) {
      const raw = JSON.parse(readFileSync(MESSAGES_FILE, "utf8")) as Record<
        string,
        ChatMessage[]
      >;
      for (const [chatId, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        chatMessages.set(
          chatId,
          list.map((message) => {
            let next: ChatMessage = message;
            if (message.sticker?.url) {
              next = {
                ...next,
                sticker: {
                  ...message.sticker,
                  url: bareUploadUrl(message.sticker.url),
                },
              };
            }
            if (!next.file?.url) return next;
            return {
              ...next,
              file: {
                ...next.file,
                url: bareUploadUrl(next.file.url),
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
      }, DEPLOY_RECONNECT_GRACE_MS);
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
            name: String(member.name || "Майко"),
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
  // Sweep ghost calls: in a healthy active call BOTH sides are mapped.
  for (const call of [...callsById.values()]) {
    if (call.status !== "active") continue;
    const callerIn = callByUser.get(call.callerId) === call.callId;
    const calleeIn = callByUser.get(call.calleeId) === call.callId;
    if (callerIn && calleeIn) continue;
    const leftId = callerIn ? call.callerId : call.calleeId;
    const goneId = callerIn ? call.calleeId : call.callerId;
    clearCall(call.callId);
    if (leftId && ioServer && userIsConnected(leftId)) {
      const gone = getUserById(goneId);
      emitToUser(ioServer, leftId, "call:signal", {
        callId: call.callId,
        fromUserId: goneId,
        fromName: gone?.displayName || gone?.username || "Майко",
        type: "peer-left",
        data: { reason: "stale" },
      });
    }
  }
  // Sweep ghost voice members: after a restart, members restored from
  // live-media.json have socketId "" — drop them if the client never rejoined.
  for (const [channelId, room] of [...voiceByChannel.entries()]) {
    const found = findVoiceChannel(channelId);
    if (!found) {
      // Channel no longer exists — drop the whole room.
      for (const userId of room.keys()) {
        voiceByUser.delete(userId);
        void removeLiveKitParticipant(channelId, userId);
      }
      voiceByChannel.delete(channelId);
      continue;
    }
    let changed = false;
    for (const [userId, member] of [...room.entries()]) {
      // Being logged in does not mean the client restored its voice session.
      if (member.socketId || Date.now() < restoredMediaUntil) continue;
      room.delete(userId);
      voiceByUser.delete(userId);
      changed = true;
      void removeLiveKitParticipant(channelId, userId);
    }
    if (room.size === 0) {
      voiceByChannel.delete(channelId);
      if (ioServer) emitVoiceState(ioServer, found.group);
      continue;
    }
    if (changed && ioServer) emitVoiceState(ioServer, found.group);
  }
  if (callsById.size || voiceByChannel.size) persistLiveMedia();
  // Prune expired call-log allowances (entries expire after 90s anyway).
  const sweepNow = Date.now();
  for (const [key, expires] of callLogAllow) {
    if (expires < sweepNow) callLogAllow.delete(key);
  }
}, 20_000).unref();

// Hourly: delete uploads no message/user references (orphans from failed sends,
// replaced avatars). Files younger than 7 days are never touched.
setInterval(() => {
  void messageTasks.exclusive(sweepMessageUploads).catch(error => console.error("[uploads:sweep]", error.name));
}, 60 * 60_000).unref();

async function sweepMessageUploads() {
  const referenced = new Set<string>();
  const addRef = (url: string | undefined | null) => {
    if (!url) return;
    try {
      const name = decodeURIComponent(path.basename(bareUploadUrl(url)));
      if (name) referenced.add(name);
    } catch {
      /* ignore */
    }
  };
  for await (const message of scanMessages()) {
      for (const file of messageAttachments(message)) addRef(file.url);
      addRef(message.sticker?.url);
  }
  for (const user of listUsers()) {
    addRef((user as { avatarUrl?: string }).avatarUrl);
    const custom = getUserById(user.id)?.ringtoneSettings?.custom;
    addRef(custom?.url);
    addRef(custom?.source?.url);
  }
  const result = sweepOrphanUploads((name) => referenced.has(name));
  if (result.removed > 0) {
    console.log(
      `[uploads] sweep removed ${result.removed} orphans (${Math.round(result.freedBytes / 1024 / 1024)} MB)`,
    );
  }
}

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

async function resolveClientMessageId(
  userId: string,
  clientIdRaw: string,
  findExisting: (id: string) => Promise<ChatMessage | undefined>,
) {
  const clientId = String(clientIdRaw || "").slice(0, 80);
  const now = Date.now();
  if (!clientId || !/^[a-zA-Z0-9_-]+$/.test(clientId)) {
    return { id: randomUUID(), existing: undefined as ChatMessage | undefined };
  }
  const key = `${userId}:${clientId}`;
  const hit = clientMsgIds.get(key);
  if (hit && hit.expires > now) {
    const existing = await findExisting(hit.id);
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

function markChatRead(userId: string, chatId: string, at = Date.now()) {
  if (!lastReadByUser.has(userId)) {
    lastReadByUser.set(userId, new Map());
  }
  const map = lastReadByUser.get(userId)!;
  const previous = map.get(chatId) ?? 0;
  if (at > previous) {
    map.set(chatId, at);
    persistReads();
  }
  return map.get(chatId) ?? at;
}

/** Latest last-read among other members — outgoing ticks (sent vs read). */
function peerReadAtFor(chatId: string, viewerId: string) {
  const chat = getChat(chatId);
  if (!chat) return null;
  let latest = 0;
  for (const memberId of chat.memberIds) {
    if (memberId === viewerId) continue;
    const at = lastReadByUser.get(memberId)?.get(chatId) ?? 0;
    if (at > latest) latest = at;
  }
  return latest || null;
}

async function emitHistory(socket: Socket, chatId: string, viewerId: string) {
  if (socket.handshake.auth?.historyPages === 1) {
    const page = await historyPage(chatId, viewerId);
    socket.emit("history", { ...page, chatId, messages: await publicMessages(page.messages, viewerId), peerReadAt: peerReadAtFor(chatId, viewerId) });
    return;
  }
  socket.emit("history", {
    chatId,
    messages: await historyForClient(chatId, viewerId),
    peerReadAt: peerReadAtFor(chatId, viewerId),
  });
}

async function messageSummary(chatId: string, viewerId: string) {
  const since = lastReadByUser.get(viewerId)?.get(chatId) ?? 0;
  return messageStore ? messageStore.summary(chatId, viewerId, since) : summarizeMessages(messagesFor(chatId), viewerId, since);
}

async function resolveReply(
  chatId: string,
  replyToId?: string,
  viewerId?: string,
): Promise<ReplyPreview | undefined> {
  if (!replyToId) return undefined;
  const source = await findMessage(chatId, replyToId, viewerId);
  if (!source || source.kind === "system") return undefined;
  if (viewerId && !messageVisibleTo(source, viewerId)) return undefined;
  const text =
    source.kind === "file"
      ? `Файл: ${source.file?.name || source.text}`
      : source.kind === "sticker"
        ? "Стикер"
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
  const peerId = peerIdOfCall(call, userId);
  if (
    !userIsConnected(peerId) ||
    callByUser.get(peerId) !== call.callId
  ) {
    // Peer is offline or already left — the call is stale.
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
  if (messageStore) throw new Error("MongoDB messages must be queried directly");
  if (!chatMessages.has(chatId)) chatMessages.set(chatId, []);
  return chatMessages.get(chatId)!;
}

async function findMessage(chatId: string, id: string, viewerId?: string) {
  if (messageStore) return messageStore.get(chatId, id, viewerId);
  return messagesFor(chatId).find(message => message.id === id && (!viewerId || messageVisibleTo(message, viewerId)));
}

async function findClientMessage(chatId: string, authorId: string, clientId: string, viewerId?: string) {
  if (messageStore) return messageStore.findClient(chatId, authorId, clientId, viewerId);
  return messagesFor(chatId).find(message => message.authorId === authorId && message.clientId === clientId && (!viewerId || messageVisibleTo(message, viewerId)));
}

async function historyPage(chatId: string, viewerId: string, before?: string) {
  return messageStore ? messageStore.page(chatId, viewerId, before) : selectHistoryPage(messagesFor(chatId), viewerId, before);
}

async function* scanMessages(chatId?: string, viewerId?: string, newestFirst = false, query: Record<string, unknown> = {}) {
  if (messageStore) {
    yield* messageStore.scan({ ...query, ...(chatId ? { room: chatId } : {}), ...(viewerId ? { "message.hiddenFor": { $ne: viewerId } } : {}) }, newestFirst);
  } else {
    const lists = chatId ? [messagesFor(chatId)] : chatMessages.values();
    for (const list of lists) {
      for (let index = newestFirst ? list.length - 1 : 0; newestFirst ? index >= 0 : index < list.length; index += newestFirst ? -1 : 1) {
        const message = list[index];
        if (!viewerId || messageVisibleTo(message, viewerId)) yield message;
      }
    }
  }
}

async function emitRoomMessage(io: Server, event: "message" | "message:update", message: ChatMessage) {
  for (const socketId of io.sockets.adapter.rooms.get(message.room) || []) {
    const client = io.sockets.sockets.get(socketId);
    if (!client) continue;
    const account = getSocketAccount(socketId);
    if (account) {
      if (!messageVisibleTo(message, account.userId)) continue;
      if (isSocketBackedUp(client)) { client.disconnect(true); continue; }
      io.to(socketId).emit(event, await publicMessage(message, account.userId));
      continue;
    }
    // Bots are not user sessions: they receive the room they were joined to.
    const bot = botSessionOf(client);
    if (!bot) continue;
    // Never echo a bot's own message back to it — that would invite reply loops.
    if (message.authorId === bot.botId) continue;
    const chat = getChat(message.room);
    if (!chat || !canAccessChat(chat, bot.botId)) continue;
    // Slow bots are throttled by their rate limits, never killed silently.
    const payload = await publicMessage(message, bot.botId);
    if (event !== "message" || message.kind === "system") {
      io.to(socketId).emit(event, payload);
      continue;
    }
    const command = isBotUserId(message.authorId) ? null : parseBotCommand(message.text);
    io.to(socketId).emit(event, command
      ? {
          ...payload,
          command: {
            name: command.name,
            args: command.args,
            target: command.target,
            // Private chat has a single bot, so `/help` is unambiguous there.
            addressed: command.target ? command.target === bot.username.toLowerCase() : chat.type === "dm",
          },
        }
      : payload);
  }
}

function clearChatMessages(chatId: string) {
  if (!messageStore) chatMessages.set(chatId, []);
  if (messageStore) messageStore.clear(chatId);
  else persistJsonMessages();
}

/** Soft-delete: keep a system tombstone so replies / history stay coherent. */
function makeDeletedTombstone(message: ChatMessage): ChatMessage {
  const fileGone = message.kind === "file";
  return {
    id: message.id,
    room: message.room,
    author: "Майко",
    text: fileGone ? "Файл удалён из сообщения" : "Сообщение удалено",
    createdAt: message.createdAt,
    kind: "system",
    hiddenFor: message.hiddenFor,
  };
}

async function redactMessage(chatId: string, messageId: string) {
  const original = await findMessage(chatId, messageId);
  if (!original) return null;
  if (original.kind === "system") return null;

  const tombstone = makeDeletedTombstone(original);
  if (!messageStore) {
    const list = messagesFor(chatId);
    list[list.findIndex(item => item.id === messageId)] = tombstone;
  }
  persistMessages([tombstone]);
  if (messageStore) messageStore.redactReplies(chatId, messageId, tombstone.text);

  const replyUpdates: ChatMessage[] = [];
  for await (const item of scanMessages(chatId, undefined, false, { "message.replyTo.id": messageId })) {
    if (item.replyTo?.id !== messageId) continue;
    item.replyTo = { ...item.replyTo, text: tombstone.text };
    if (!messageStore) persistMessages([item]);
    replyUpdates.push(item);
  }

  return { tombstone, replyUpdates, original };
}

/** Mark pending invites to a deleted group as expired across all DMs. */
async function expireInvitesForGroup(
  io: Server,
  groupId: string,
  groupTitle: string,
) {
  const text = `Группа «${groupTitle}» удалена`;
  if (messageStore) messageStore.expireInvites(groupId, text);
  for await (const item of scanMessages(undefined, undefined, false, { "message.invite.groupId": groupId, "message.invite.status": "expired" })) {
      if (
        item.kind !== "invite" ||
        !item.invite ||
        item.invite.groupId !== groupId ||
        item.invite.status !== (messageStore ? "expired" : "pending")
      ) {
        continue;
      }
      item.text = text;
      item.invite = { ...item.invite, status: "expired" };
      if (!messageStore) persistMessages([item]);
      await emitRoomMessage(io, "message:update", item);
      const chat = getChat(item.room);
      if (chat) await notifyChatMembers(io, chat);
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

    if (presence.room === chatId || presence.room?.startsWith(`${chatId}::text_`)) {
      const roomId = presence.room;
      memberSocket.leave(roomId);
      presence.room = null;
      usersBySocket.set(socketId, presence);
      if (roomId !== chatId) memberSocket.emit("chat:left", { chatId: roomId });
    }
    memberSocket.emit("chat:left", { chatId });
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
  const online = new Set(
    [...usersBySocket.values()]
      .filter((user) => Boolean(user.userId))
      .map((user) => user.userId),
  );
  // Bots have no presence entry; a live bot socket means the bot is online.
  for (const botId of botSocketsById.keys()) online.add(botId);
  return online;
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

async function publicMessage(message: ChatMessage, viewerId?: string, replySource?: ChatMessage | null): Promise<ChatMessage> {
  let next: ChatMessage = { ...message };
  delete next.hiddenFor;
  if (viewerId && next.replyTo) {
    const source = replySource === undefined ? await findMessage(message.room, next.replyTo.id) : replySource;
    if (source && !messageVisibleTo(source, viewerId)) next = { ...next, replyTo: undefined };
  }
  if (message.sticker?.url) {
    next = {
      ...next,
      sticker: {
        ...message.sticker,
        url: signUploadUrl(bareUploadUrl(message.sticker.url)),
      },
    };
  }
  const attachments = messageAttachments(next);
  if (!attachments.length) return next;
  const signed = await Promise.all(attachments.map(async (file) => ({
    ...file,
    microPreview: isGifAttachment(file) ? undefined : validMicroPreview(file.microPreview) || await getUploadMicroPreview(file),
    url: signUploadUrl(bareUploadUrl(file.url)),
  })));
  return {
    ...next,
    file: signed[0],
    files: signed.length > 1 ? signed : undefined,
  };
}

async function publicMessages(messages: readonly ChatMessage[], viewerId: string) {
  if (!messageStore) return Promise.all(messages.map(message => publicMessage(message, viewerId)));
  const rooms = new Map<string, Set<string>>();
  for (const message of messages) {
    if (!message.replyTo) continue;
    const ids = rooms.get(message.room) ?? new Set<string>();
    ids.add(message.replyTo.id);
    rooms.set(message.room, ids);
  }
  const sources = new Map<string, ChatMessage>();
  await Promise.all([...rooms].map(async ([room, ids]) => {
    for (const source of await messageStore.getMany(room, [...ids])) sources.set(JSON.stringify([room, source.id]), source);
  }));
  return Promise.all(messages.map(message => publicMessage(message, viewerId,
    message.replyTo ? sources.get(JSON.stringify([message.room, message.replyTo.id])) ?? null : null)));
}

async function historyForClient(chatId: string, viewerId: string) {
  const messages: ChatMessage[] = [];
  for await (const message of scanMessages(chatId, viewerId)) {
    if (isThreadMessage(message)) messages.push(await publicMessage(message, viewerId));
  }
  return messages;
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
      ...(user.isBot ? { isBot: true } : {}),
      ...botPeopleFields(user.id, user.isBot),
    }))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, "ru");
    });
}

function searchPeople(viewerId: string, queryRaw: string) {
  function score(user: { username: string; displayName: string }) {
    return personSearchScore(user, queryRaw);
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
    .slice(0, 20)
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
        ? signAvatarUrl(bareUploadUrl(user.avatarUrl))
        : undefined,
      ...(user.isBot ? { isBot: true } : {}),
      ...botPeopleFields(user.id, user.isBot),
    }));
}

function suggestPeople(viewerId: string, query = "") {
  if (query.trim()) return searchPeople(viewerId, query);
  const contacts = contactIdsFor(viewerId);
  const online = onlineUserIds();
  return listUsers()
    .filter((user) => user.id !== viewerId && contacts.has(user.id))
    .sort((a, b) => {
      const aOnline = online.has(a.id);
      const bOnline = online.has(b.id);
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, "ru");
    })
    .slice(0, 12)
    .map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
        ? signAvatarUrl(bareUploadUrl(user.avatarUrl))
        : undefined,
      ...(user.isBot ? { isBot: true } : {}),
      ...botPeopleFields(user.id, user.isBot),
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

/** Bot description/commands for people payloads (empty for humans). */
function botPeopleFields(userId: string, isBot?: boolean) {
  if (!isBot) return {};
  const meta = botProfileMeta(userId);
  if (!meta) return {};
  return {
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.commands.length ? { commands: meta.commands } : {}),
  };
}

async function chatInfo(chat: ChatMeta, viewerId: string) {
  const { count, unreadCount, last } = await messageSummary(chat.id, viewerId);
  const preview = last ? chatListPreview(last) : null;
  const peer = peerIdForViewer(chat, viewerId);
  const peerUser = peer ? getUserById(peer) : undefined;
  const peerBotMeta = peerUser?.isBot ? botProfileMeta(peerUser.id) : null;

  const group =
    chat.type === "group" ? ensureVoiceChannels(chat) : chat;

  return {
    id: chat.id,
    type: chat.type,
    title: dmTitleForViewer(chat, viewerId),
    topic: chat.type === "dm" && peerBotMeta?.description
      ? peerBotMeta.description
      : chat.topic,
    online: presenceNames(chat.id).length,
    messages: count,
    members: chat.type === "channel" ? onlineUserIds().size : chat.memberIds.length,
    unreadCount,
    pinned: isPinned(viewerId, chat.id),
    peerId: peer,
    ...(peerUser?.isBot
      ? {
          peerIsBot: true,
          peerUsername: peerUser.username,
          ...(peerBotMeta?.description
            ? { peerDescription: peerBotMeta.description }
            : {}),
          ...(peerBotMeta?.commands.length
            ? { peerCommands: peerBotMeta.commands }
            : {}),
        }
      : {}),
    avatarUrl: chat.avatarUrl
      ? signAvatarUrl(bareUploadUrl(chat.avatarUrl))
      : undefined,
    createdBy: chat.createdBy,
    memberIds: chat.type === "group" ? [...chat.memberIds] : undefined,
    visibility: chat.type === "group" ? groupVisibility(chat) : undefined,
    lastMessage: last && preview
      ? {
          author: last.author,
          authorId: last.authorId,
          text: preview.text || "",
          createdAt: last.createdAt,
          kind: last.kind,
          thumbUrl: preview.thumbUrl
            ? signUploadUrl(bareUploadUrl(preview.thumbUrl))
            : undefined,
          thumbAnimated: preview.thumbAnimated,
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
    textChannels:
      group.type === "group"
        ? await Promise.all((group.textChannels || []).map(async (channel) => ({
            id: channel.id,
            title: channel.title,
            unreadCount: (await messageSummary(channel.id, viewerId)).unreadCount,
          })))
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
    // Bots track channel occupancy so scripts can answer "кто в канале".
    if (isBotUserId(memberId)) {
      emitToBotSockets(io, memberId, "bot:voiceState", payload);
    }
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

async function collectRoomMedia(
  chatId: string,
  filter: "media" | "file" | "all",
  viewerId: string,
  offset: number,
  limit: number,
) {
  const items: RoomMediaItem[] = [];
  let total = 0;
  for await (const message of scanMessages(chatId, viewerId, true, { "message.kind": "file" })) {
    if (message.kind !== "file") continue;
    for (const file of messageAttachments(message).reverse()) {
      const classified = classifyRoomFile(file);
      if (filter === "media" && classified.category !== "media") continue;
      if (filter === "file" && classified.category === "media") continue;
      const index = total++;
      if (index < offset || items.length >= limit) continue;
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
  const enriched = await Promise.all(items.map(async item => ({
    ...item,
    file: { ...item.file, microPreview: isGifAttachment(item.file) ? undefined
      : validMicroPreview(item.file.microPreview) || await getUploadMicroPreview(item.file) },
  })));
  return { items: enriched, total, hasMore: offset + items.length < total };
}

function socketsForUser(userId: string) {
  return [...usersBySocket.entries()]
    .filter(([, presence]) => presence.userId === userId)
    .map(([socketId]) => socketId);
}

function emitToUser(io: Server, userId: string, event: string, payload: unknown) {
  for (const socketId of socketsForUser(userId)) {
    const client = io.sockets.sockets.get(socketId);
    if (client && isSocketBackedUp(client)) { client.disconnect(true); continue; }
    io.to(socketId).emit(event, payload);
  }
}

/** botId → socket ids of the bot process(es) currently connected. */
const botSocketsById = new Map<string, Set<string>>();

type BotSocketSession = {
  botId: string;
  username: string;
  displayName: string;
};

function botSocketIds(botId: string) {
  return botSocketsById.get(botId) ?? new Set<string>();
}

/** Delivers an event to every live socket of one bot; returns the delivery count. */
function emitToBotSockets(io: Server, botId: string, event: string, payload: unknown) {
  let delivered = 0;
  for (const socketId of botSocketIds(botId)) {
    const target = io.sockets.sockets.get(socketId);
    if (!target) continue;
    target.emit(event, payload);
    delivered += 1;
  }
  return delivered;
}

function registerBotSocket(botId: string, socketId: string) {
  const sockets = botSocketsById.get(botId) ?? new Set<string>();
  sockets.add(socketId);
  botSocketsById.set(botId, sockets);
}

function unregisterBotSocket(botId: string, socketId: string) {
  const sockets = botSocketsById.get(botId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) botSocketsById.delete(botId);
}

function botSessionOf(socket: Socket): BotSocketSession | null {
  const session = socket.data?.bot as BotSocketSession | undefined;
  return session && typeof session.botId === "string" ? session : null;
}

/** Every message bucket of a chat: #general plus the extra text channels. */
function chatRoomIds(chat: ChatMeta) {
  return [chat.id, ...(chat.textChannels || []).map((channel) => channel.id)];
}

/**
 * A bot added to a chat while connected must start receiving its messages
 * without reconnecting. Bots are joined to every room of the chat.
 */
function syncBotRooms(io: Server, chat: ChatMeta) {
  const rooms = chatRoomIds(chat);
  for (const memberId of chat.memberIds) {
    if (!findBot(memberId)) continue;
    for (const socketId of botSocketIds(memberId)) {
      const botSocket = io.sockets.sockets.get(socketId);
      if (!botSocket) continue;
      for (const roomId of rooms) botSocket.join(roomId);
      botSocket.emit("bot:added", {
        chatId: chat.id,
        type: chat.type,
        title: chat.title,
      });
    }
  }
}

function botChatSummaries(botId: string) {
  return listChatsForUser(botId).map((chat) => ({
    id: chat.id,
    type: chat.type,
    title: chat.type === "dm" ? dmTitleForViewer(chat, botId) : chat.title,
    topic: chat.topic,
    rooms: chatRoomIds(chat),
    peerId: peerIdForViewer(chat, botId),
    voiceChannels:
      chat.type === "group"
        ? (chat.voiceChannels || []).map((channel) => ({
            id: channel.id,
            title: channel.title,
            users: voiceUsersForChannel(channel.id),
          }))
        : undefined,
  }));
}

type BotVoiceChannel = {
  group: ChatMeta;
  channel: VoiceChannelMeta;
  channelId: string;
};

function botVoiceChannel(botId: string, raw: unknown): BotVoiceChannel | null {
  const channelId = String(raw || "").slice(0, 200);
  const found = findVoiceChannel(channelId);
  if (!found || !canAccessChat(found.group, botId)) return null;
  return { group: found.group, channel: found.channel, channelId };
}

/**
 * LiveKit credentials for a bot. The bot process publishes audio/video itself;
 * the server only registers presence and grants publish rights for the room.
 */
async function botVoiceCredentials(
  socket: Socket,
  bot: BotSocketSession,
  channelId: string,
) {
  const config = loadLiveKitConfig();
  if (!config.url || !config.apiKey || !config.apiSecret) return null;
  const participant = new AccessToken(config.apiKey, config.apiSecret, {
    identity: bot.botId,
    name: bot.displayName,
    ttl: "2h",
  });
  participant.addGrant({
    roomJoin: true,
    room: liveKitRoomName(channelId),
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: [
      TrackSource.MICROPHONE,
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ],
  });
  return {
    url: publicLiveKitUrl(socket.request),
    room: liveKitRoomName(channelId),
    token: await participant.toJwt(),
    canPublish: ["microphone", "camera", "screen_share", "screen_share_audio"],
  };
}

function botJoinVoice(
  io: Server,
  socket: Socket,
  bot: BotSocketSession,
  channelIdRaw: unknown,
) {
  const found = botVoiceChannel(bot.botId, channelIdRaw);
  if (!found) return { ok: false as const, error: "Голосовой канал не найден" };
  const channelId = found.channelId;

  // A bot is in one channel at a time; drop previous presence (any socket).
  const previousChannel = voiceByUser.get(bot.botId);
  if (previousChannel) {
    const previousRoom = voiceByChannel.get(previousChannel);
    const previousMember = previousRoom?.get(bot.botId);
    if (previousRoom && previousMember) {
      const previousSize = previousRoom.size;
      previousRoom.delete(bot.botId);
      voiceBySocket.delete(previousMember.socketId);
      if (previousRoom.size === 0) voiceByChannel.delete(previousChannel);
      voiceByUser.delete(bot.botId);
      void removeLiveKitParticipant(previousChannel, bot.botId);
      maybeBumpVoiceTopology(previousChannel, previousSize);
      const previousFound = findVoiceChannel(previousChannel);
      if (previousFound) emitVoiceState(io, previousFound.group);
    }
  }
  voiceBySocket.delete(socket.id);

  let room = voiceByChannel.get(channelId);
  if (!room) {
    room = new Map<string, VoiceMember>();
    voiceByChannel.set(channelId, room);
  }
  if (room.size >= 12) return { ok: false as const, error: "Канал заполнен" };

  const previousSize = room.size;
  const member: VoiceMember = {
    userId: bot.botId,
    name: bot.displayName,
    muted: true,
    deafened: false,
    speaking: false,
    cameraOff: true,
    sharingScreen: false,
    mediaRevision: 0,
    avatarUrl: getUserById(bot.botId)?.avatarUrl,
    socketId: socket.id,
  };
  room.set(bot.botId, member);
  voiceByUser.set(bot.botId, channelId);
  voiceBySocket.set(socket.id, channelId);
  maybeBumpVoiceTopology(channelId, previousSize);
  persistLiveMedia();
  emitVoiceState(io, found.group);

  return {
    ok: true as const,
    channelId,
    groupId: found.group.id,
    channel: { id: found.channel.id, title: found.channel.title },
    members: voiceUsersForChannel(channelId),
  };
}

function botLeaveVoice(io: Server, socket: Socket, bot: BotSocketSession) {
  const channelId = voiceByUser.get(bot.botId) || null;
  leaveVoiceChannel(io, socket, bot.botId);
  return {
    ok: true as const,
    channelId,
    members: channelId ? voiceUsersForChannel(channelId) : [],
  };
}

function botSetVoiceMedia(
  io: Server,
  socket: Socket,
  bot: BotSocketSession,
  payload: {
    muted?: unknown;
    deafened?: unknown;
    cameraOff?: unknown;
    sharingScreen?: unknown;
  },
) {
  const channelId = voiceByUser.get(bot.botId);
  if (!channelId) return { ok: false as const, error: "Бот не в голосовом канале" };
  const room = voiceByChannel.get(channelId);
  const member = room?.get(bot.botId);
  if (!room || !member || member.socketId !== socket.id) {
    return { ok: false as const, error: "Нет доступа" };
  }

  let supplied = false;
  let changed = false;
  const apply = (
    key: "muted" | "deafened" | "cameraOff" | "sharingScreen",
    value: unknown,
  ) => {
    if (typeof value !== "boolean") return;
    supplied = true;
    if (member[key] !== value) {
      member[key] = value;
      changed = true;
    }
  };
  apply("muted", payload?.muted);
  apply("deafened", payload?.deafened);
  apply("cameraOff", payload?.cameraOff);
  apply("sharingScreen", payload?.sharingScreen);
  if (!supplied) return { ok: false as const, error: "Нет изменений" };
  if (member.muted) member.speaking = false;
  if (changed) member.mediaRevision += 1;
  room.set(bot.botId, member);

  const mediaState = {
    channelId,
    userId: bot.botId,
    cameraOff: member.cameraOff,
    sharingScreen: member.sharingScreen,
    mediaRevision: member.mediaRevision,
  };
  for (const voiceMember of room.values()) {
    io.to(voiceMember.socketId).emit("voice:media", mediaState);
  }
  if (changed) {
    const found = findVoiceChannel(channelId);
    if (found) emitVoiceState(io, found.group);
  }
  return {
    ok: true as const,
    channelId,
    muted: member.muted,
    deafened: member.deafened,
    cameraOff: member.cameraOff,
    sharingScreen: member.sharingScreen,
    mediaRevision: member.mediaRevision,
  };
}

function botVoiceMembers(botId: string, channelIdRaw: unknown) {
  const found = botVoiceChannel(botId, channelIdRaw);
  if (!found) return null;
  return {
    channelId: found.channelId,
    groupId: found.group.id,
    title: found.channel.title,
    members: voiceUsersForChannel(found.channelId),
  };
}

async function pushMessage(io: Server, chat: ChatMeta, message: ChatMessage) {
  const roomId = messageRoomFor(chat, message.room);
  message.room = roomId;
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
  if (!messageStore) messagesFor(roomId).push(message);
  persistNewMessage(message);

  // Only the author is auto-marked read; viewers emit chats:read themselves
  // so background tabs keep unread badges.
  if (message.authorId) {
    markChatRead(message.authorId, roomId);
  }

  await emitRoomMessage(io, "message", message);
  await notifyChatMembers(io, chat);

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
        author: "Майко",
        text: `Новое сообщение в #${chat.title}`,
      };
      for (const [socketId, presence] of usersBySocket.entries()) {
        if (!presence.userId || presence.userId === message.authorId) continue;
        if (presence.room === chat.id) continue;
        io.to(socketId).emit("message:ping", ping);
      }
    } else {
      const ping = {
        room: roomId,
        author: message.author,
        text: preview.slice(0, 180),
      };
      for (const userId of chat.memberIds) {
        if (userId === message.authorId) continue;
        // Bots have no browser tab and no push subscription.
        if (isBotUserId(userId)) continue;
        let viewing = false;
        for (const socketId of socketsForUser(userId)) {
          const presence = usersBySocket.get(socketId);
          if (presence?.room === roomId) {
            viewing = true;
            continue;
          }
          io.to(socketId).emit("message:ping", ping);
        }
        // Wake suspended phone tabs that dropped the socket.
        if (!viewing) {
          void sendPushToUser(userId, {
            title: String(message.author || "Майко"),
            body: String(preview || "Новое сообщение").slice(0, 180),
            chatId: roomId,
            kind: "message",
            tag: `pulse-${roomId}`,
          });
        }
      }
    }
  }
}

function voiceAttachmentOf(message: ChatMessage) {
  return messageAttachments(message).find((file) => isVoiceNote(file)) || null;
}

async function startVoiceTranscription(
  io: Server,
  chat: ChatMeta,
  message: ChatMessage,
  options?: { force?: boolean },
) {
  const voice = voiceAttachmentOf(message);
  if (!voice) return;
  if (
    !options?.force &&
    message.transcriptionStatus === "ready" &&
    typeof message.transcription === "string"
  ) {
    return;
  }
  if (!hasTranscriptionKey()) {
    message.transcriptionStatus = "error";
    persistMessages([message]);
    await emitRoomMessage(io, "message:update", message);
    return;
  }

  message.transcriptionStatus = "pending";
  persistMessages([message]);
  await emitRoomMessage(io, "message:update", message);

  const finish = (text?: string) => messageTasks.run(["room:" + chat.id], async () => {
    const current = await findMessage(chat.id, message.id);
    if (!current || current.kind !== "file" || voiceAttachmentOf(current)?.url !== voice.url) return;
    if (text !== undefined) current.transcription = text;
    current.transcriptionStatus = text === undefined ? "error" : "ready";
    persistMessages([current]);
    await emitRoomMessage(io, "message:update", current);
  });
  void queueTranscription(message.id, () =>
    withUploadFile(voice.url, (diskPath) => transcribeAudioFile(diskPath, voice.name, voice.mime)),
  )
    .then(text => finish(text))
    .catch((error: Error) => {
      console.warn("[transcribe]", message.id, error);
      return finish();
    }).catch((error: Error) => {
      console.error("[transcribe:persist]", error.name);
    });
}

async function chatsForUser(userId: string) {
  const chats = listChatsForUser(userId);
  const infos = await Promise.all(chats.map(async chat => {
    const info = await chatInfo(chat, userId);
    return chat.type !== "dm" || !chat.visibleTo || chat.visibleTo.includes(userId) || info.messages > 0 ? info : null;
  }));
  return infos.filter(info => info !== null)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aTime = a.lastMessage?.createdAt ?? a.createdAt;
      const bTime = b.lastMessage?.createdAt ?? b.createdAt;
      return bTime - aTime;
    });
}

async function emitChats(socket: Socket, userId: string) {
  socket.emit("chats", await chatsForUser(userId));
}

async function chatUpdateFor(chat: ChatMeta, userId: string) {
  if (getChat(chat.id) !== chat || !canAccessChat(chat, userId)) return { chatId: chat.id, chat: null };
  const info = await chatInfo(chat, userId);
  const visible = chat.type !== "dm" || !chat.visibleTo || chat.visibleTo.includes(userId) || info.messages > 0;
  return { chatId: chat.id, chat: visible ? info : null };
}

function broadcastPeople(io: Server) {
  for (const [socketId, presence] of usersBySocket.entries()) {
    if (!presence.userId) continue;
    io.to(socketId).emit("people", peopleForViewer(presence.userId));
  }
}

async function notifyChatMembers(io: Server, chat: ChatMeta) {
  // Reuse only within this notification: each user's windows share a view,
  // while later notifications always reflect edits, reads and hidden history.
  const lists = new Map<string, Awaited<ReturnType<typeof chatsForUser>>>();
  const updates = new Map<string, Awaited<ReturnType<typeof chatUpdateFor>>>();
  const memberIds = new Set(chat.memberIds);
  for (const [socketId, presence] of usersBySocket.entries()) {
    if (!presence.userId || (chat.type !== "channel" && !memberIds.has(presence.userId))) continue;
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    if (socket.handshake.auth?.chatPatches === 1 && chat.type !== "channel") {
      let update = updates.get(presence.userId);
      if (!update) {
        update = await chatUpdateFor(chat, presence.userId);
        updates.set(presence.userId, update);
      }
      socket.emit("chat:update", update);
      continue;
    }
    let list = lists.get(presence.userId);
    if (!list) {
      list = await chatsForUser(presence.userId);
      lists.set(presence.userId, list);
    }
    socket.emit("chats", list);
  }
}

function pushSystem(room: string, text: string) {
  const message: ChatMessage = {
    id: randomUUID(),
    room,
    author: "Майко",
    text,
    createdAt: Date.now(),
    kind: "system",
  };
  if (!messageStore) messagesFor(room).push(message);
  persistNewMessage(message);
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
  if (chat) void notifyChatMembers(io, chat).catch(error => console.error("[chats:update]", error.name));
}

async function joinChat(
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
  const roomId = messageRoomFor(chat, chatId);

  const previous = usersBySocket.get(socket.id);
  if (previous?.room === roomId) {
    // Re-send history so clients that cleared the list (same-chat reopen) recover.
    const readAt = markChatRead(account.userId, roomId);
    socket.to(roomId).emit("chat:read", {
      chatId: roomId,
      userId: account.userId,
      readAt,
    });
    await emitHistory(socket, roomId, account.userId);
    return {
      ok: true as const,
      session: { name: labelOf(account), room: roomId },
    };
  }

  await leaveCurrentRoom(io, socket, chat.type === "dm");

  socket.join(roomId);
  usersBySocket.set(socket.id, {
    userId: account.userId,
    name: labelOf(account),
    room: roomId,
  });

  // Presence updates below — don't spam the thread with join notices.

  const readAt = markChatRead(account.userId, roomId);
  socket.to(roomId).emit("chat:read", {
    chatId: roomId,
    userId: account.userId,
    readAt,
  });
  await emitHistory(socket, roomId, account.userId);
  io.to(roomId).emit("presence", {
    chatId: roomId,
    names: presenceNames(roomId),
  });
  await notifyChatMembers(io, chat);
  broadcastPeople(io);

  return {
    ok: true as const,
    session: { name: labelOf(account), room: roomId },
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

async function afterAuth(io: Server, socket: Socket, account: AuthAccount) {
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
  await emitChats(socket, account.userId);
  broadcastPeople(io);

  // Re-deliver ringing call after phone woke / tab reconnected.
  const ringing = ringingCallForUser(account.userId);
  if (ringing) {
    const caller = getUserById(ringing.callerId);
    socket.emit("call:incoming", {
      callId: ringing.callId,
      fromUserId: ringing.callerId,
      fromName: caller?.displayName || caller?.username || "Майко",
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
    if (callByUser.get(peerId) !== liveCall.callId) {
      // Peer already left this call — it's a ghost. Kill it instead of
      // resuming a call that only exists in stale state.
      clearCall(liveCall.callId);
    } else {
      const peerPresent = userIsConnected(peerId);
      socket.emit("call:resume", {
        callId: liveCall.callId,
        peerId,
        peerName: peer?.displayName || peer?.username || "Майко",
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
}

type BotAck = (result: Record<string, unknown>) => void;

type BotFileInput = {
  url?: string;
  name?: string;
  size?: number;
  mime?: string;
  width?: number;
  height?: number;
};

/** Resolve a bot's membership in a chat (text channels resolve to their group). */
function botChatAccess(botId: string, chatIdRaw: unknown) {
  const chatId = String(chatIdRaw || "").slice(0, 200);
  const chat = getChat(chatId);
  if (!chat || !canAccessChat(chat, botId)) return null;
  return { chat, roomId: messageRoomFor(chat, chatId) };
}

/**
 * Bot socket session: no presence entry, no user handlers — only the small
 * bot API below. A bot joins every room of every chat it is a member of.
 */
function attachBotSocket(io: Server, socket: Socket, bot: BotSocketSession) {
  const record = findBot(bot.botId);
  if (!record) {
    socket.disconnect(true);
    return;
  }

  registerBotSocket(bot.botId, socket.id);
  markBotConnected(bot.botId);

  const joinAll = () => {
    for (const chat of listChatsForUser(bot.botId)) {
      for (const roomId of chatRoomIds(chat)) socket.join(roomId);
    }
  };
  joinAll();
  broadcastPeople(io);
  socket.emit("bot:ready", {
    ok: true,
    bot: publicBot(record),
    chats: botChatSummaries(bot.botId),
  });

  function onBot<Args extends unknown[]>(
    event: string,
    handler: (...args: Args) => Promise<void> | void,
  ) {
    socket.on(event, (...args: Args) => {
      void (async () => {
        try {
          await handler(...args);
        } catch (error) {
          console.error("[bot:" + event + "]", (error as Error).name);
          const ack = args[args.length - 1];
          if (typeof ack === "function") {
            (ack as BotAck)({ ok: false, error: "Внутренняя ошибка сервера" });
          }
        }
      })();
    });
  }

  onBot(
    "bot:send",
    async (
      payload: {
        chatId?: string;
        text?: string;
        replyToId?: string;
        clientId?: string;
        buttons?: unknown;
      },
      ack?: BotAck,
    ) => {
      if (typeof ack !== "function") return;
      const access = botChatAccess(bot.botId, payload?.chatId);
      if (!access) {
        ack({ ok: false, error: "Бот не участник этого чата" });
        return;
      }
      if (
        !rateLimit(`bot-send:${bot.botId}`, 60, 60_000) ||
        !rateLimit(`bot-send-room:${bot.botId}:${access.roomId}`, 30, 60_000)
      ) {
        ack({ ok: false, error: "Слишком много сообщений" });
        return;
      }
      const text = sanitizeBotText(payload?.text, BOT_MAX_TEXT);
      if (!text) {
        ack({ ok: false, error: "Пустое сообщение" });
        return;
      }
      const buttons = normalizeBotButtons(payload?.buttons);
      if (buttons === null) {
        ack({ ok: false, error: "Некорректные кнопки" });
        return;
      }

      const rawClientId = String(payload?.clientId || "").slice(0, 80);
      const clientId = /^[a-zA-Z0-9_-]+$/.test(rawClientId) ? rawClientId : "";
      // Same per-room ordering as human messages, and the duplicate check must
      // live inside it so two retries cannot both win the race.
      await messageTasks.run(["room:" + access.roomId], async () => {
        if (clientId) {
          const duplicate = await findClientMessage(access.roomId, bot.botId, clientId, bot.botId);
          if (duplicate) {
            ack({ ok: true, messageId: duplicate.id, duplicate: true });
            return;
          }
        }
        const message: ChatMessage = {
          id: randomUUID(),
          room: access.roomId,
          author: bot.displayName,
          authorId: bot.botId,
          text,
          createdAt: Date.now(),
          kind: "text",
          clientId: clientId || undefined,
          ...(buttons ? { buttons } : {}),
          replyTo: await resolveReply(access.roomId, payload?.replyToId, bot.botId),
        };
        await pushMessage(io, access.chat, message);
        ack({ ok: true, messageId: message.id });
      });
    },
  );

  onBot(
    "bot:sendFile",
    async (
      payload: {
        chatId?: string;
        text?: string;
        caption?: string;
        replyToId?: string;
        file?: BotFileInput;
        files?: BotFileInput[];
        buttons?: unknown;
      },
      ack?: BotAck,
    ) => {
      if (typeof ack !== "function") return;
      const access = botChatAccess(bot.botId, payload?.chatId);
      if (!access) {
        ack({ ok: false, error: "Бот не участник этого чата" });
        return;
      }
      if (!rateLimit(`bot-file:${bot.botId}`, 30, 60_000)) {
        ack({ ok: false, error: "Слишком много файлов" });
        return;
      }
      const buttons = normalizeBotButtons(payload?.buttons);
      if (buttons === null) {
        ack({ ok: false, error: "Некорректные кнопки" });
        return;
      }
      const rawList =
        Array.isArray(payload?.files) && payload.files.length
          ? payload.files
          : payload?.file
            ? [payload.file]
            : [];
      if (!rawList.length) {
        ack({ ok: false, error: "Файл не передан" });
        return;
      }
      if (rawList.length > BOT_MAX_FILES) {
        ack({ ok: false, error: `Не больше ${BOT_MAX_FILES} файлов в сообщении` });
        return;
      }

      const resolved: {
        url: string;
        name: string;
        size: number;
        mime: string;
        isAudio: boolean;
        width?: number;
        height?: number;
      }[] = [];
      for (const file of rawList) {
        const url = String(file?.url || "");
        const remote = parseGiphyMediaUrl(url);
        if (remote) {
          resolved.push({
            url: remote.url,
            name: sanitizeBotText(file?.name || remote.name, 120) || remote.name,
            size: Math.max(0, Math.min(Number(file?.size) || 0, 20 * 1024 * 1024)),
            mime: remote.mime,
            isAudio: false,
            ...parseMediaSize(file),
          });
          continue;
        }
        const stored = await getUploadInfo(url).catch(() => null);
        if (!stored) {
          ack({ ok: false, error: `Файл не найден: ${sanitizeBotText(file?.name || url, 80)}` });
          return;
        }
        if (!uploadOwnedBy(url, bot.botId)) {
          ack({ ok: false, error: "Этот файл загружен другим аккаунтом" });
          return;
        }
        const name = sanitizeBotText(file?.name || stored.fileName, 120) || stored.fileName;
        const mime =
          String(file?.mime || stored.mime || mimeFromName(stored.fileName))
            .split(";")[0]
            .trim()
            .toLowerCase() || "application/octet-stream";
        const attachment = { url, name, size: stored.size, mime };
        resolved.push({
          url: bareUploadUrl(url),
          name,
          size: stored.size,
          mime,
          isAudio: mime.startsWith("audio/") || isAudioAttachment(attachment),
          ...parseMediaSize(file),
        });
      }

      const album =
        resolved.length > 1 &&
        resolved.every((item) => isImageAttachment(item) || isVideoAttachment(item));
      if (resolved.length > 1 && !album) {
        ack({ ok: false, error: "В одном сообщении можно объединять только фото и видео" });
        return;
      }

      const attachments = await Promise.all(
        resolved.map(async ({ url, name, size, mime, width, height }) => {
          const microPreview = await getUploadMicroPreview({ url, name, size, mime });
          return {
            url,
            name,
            size,
            mime,
            ...(width && height ? { width, height } : {}),
            ...(microPreview ? { microPreview } : {}),
          };
        }),
      );
      const first = resolved[0];
      const caption = sanitizeBotText(payload?.caption ?? payload?.text, BOT_MAX_CAPTION);
      const text = album
        ? caption
        : first.isAudio
          ? caption || "Аудио"
          : isImageAttachment(first) || isVideoAttachment(first)
            ? caption
            : caption || first.name;

      await messageTasks.run(["room:" + access.roomId], async () => {
        // Storage work yielded: membership might have changed meanwhile.
        const current = botChatAccess(bot.botId, payload?.chatId);
        if (!current || current.roomId !== access.roomId) {
          ack({ ok: false, error: "Бот больше не участник этого чата" });
          return;
        }
        const message: ChatMessage = {
          id: randomUUID(),
          room: access.roomId,
          author: bot.displayName,
          authorId: bot.botId,
          text: text.slice(0, 200),
          createdAt: Date.now(),
          kind: "file",
          file: attachments[0],
          files: attachments.length > 1 ? attachments : undefined,
          ...(buttons ? { buttons } : {}),
          replyTo: await resolveReply(access.roomId, payload?.replyToId, bot.botId),
        };
        await pushMessage(io, current.chat, message);
        ack({ ok: true, messageId: message.id, url: message.file?.url });
      });
    },
  );

  onBot(
    "bot:edit",
    async (
      payload: {
        chatId?: string;
        messageId?: string;
        text?: unknown;
        buttons?: unknown;
      },
      ack?: BotAck,
    ) => {
      if (typeof ack !== "function") return;
      const access = botChatAccess(bot.botId, payload?.chatId);
      const messageId = String(payload?.messageId || "").slice(0, 200);
      if (!access || !messageId) {
        ack({ ok: false, error: "Некорректный запрос" });
        return;
      }
      if (!rateLimit(`bot-edit:${bot.botId}`, 60, 60_000)) {
        ack({ ok: false, error: "Слишком много изменений" });
        return;
      }
      const hasText = Object.prototype.hasOwnProperty.call(payload || {}, "text");
      const hasButtons = Object.prototype.hasOwnProperty.call(payload || {}, "buttons");
      if (!hasText && !hasButtons) {
        ack({ ok: false, error: "Нечего менять" });
        return;
      }
      const text = hasText ? sanitizeBotText(payload?.text, BOT_MAX_TEXT) : undefined;
      if (hasText && !text) {
        ack({ ok: false, error: "Пустой текст" });
        return;
      }
      // `buttons: []` clears the keyboard, omitted `buttons` keeps it.
      const buttons = hasButtons ? normalizeBotButtons(payload?.buttons) : undefined;
      if (buttons === null) {
        ack({ ok: false, error: "Некорректные кнопки" });
        return;
      }

      await messageTasks.run(["room:" + access.roomId], async () => {
        const message = await findMessage(access.roomId, messageId, bot.botId);
        if (!message || message.authorId !== bot.botId || message.kind === "system") {
          ack({ ok: false, error: "Сообщение не найдено" });
          return;
        }
        if (text !== undefined) message.text = text;
        if (hasButtons) {
          if (buttons) message.buttons = buttons;
          else delete message.buttons;
        }
        message.editedAt = Date.now();
        persistMessages([message]);
        await emitRoomMessage(io, "message:update", message);
        await notifyChatMembers(io, access.chat);
        ack({ ok: true, messageId: message.id });
      });
    },
  );

  onBot(
    "bot:setCommands",
    async (payload: { commands?: unknown }, ack?: BotAck) => {
      if (typeof ack !== "function") return;
      if (!rateLimit(`bot-profile:${bot.botId}`, 12, 60_000)) {
        ack({ ok: false, error: "Слишком часто" });
        return;
      }
      const result = setBotCommands(bot.botId, payload?.commands);
      if (!result.ok) {
        ack({ ok: false, error: result.error });
        return;
      }
      broadcastPeople(io);
      for (const chat of listChatsForUser(bot.botId)) {
        await notifyChatMembers(io, chat);
      }
      ack({ ok: true, commands: result.commands });
    },
  );

  onBot(
    "bot:setProfile",
    async (
      payload: {
        description?: unknown;
        displayName?: unknown;
        avatarUrl?: unknown;
      },
      ack?: BotAck,
    ) => {
      if (typeof ack !== "function") return;
      if (!rateLimit(`bot-profile:${bot.botId}`, 12, 60_000)) {
        ack({ ok: false, error: "Слишком часто" });
        return;
      }
      if (
        payload?.description === undefined &&
        payload?.displayName === undefined &&
        payload?.avatarUrl === undefined
      ) {
        ack({ ok: false, error: "Нечего менять" });
        return;
      }

      const avatarPatch: { avatarUrl?: string | null } = {};
      if (payload?.avatarUrl === null) {
        avatarPatch.avatarUrl = null;
      } else if (typeof payload?.avatarUrl === "string" && payload.avatarUrl) {
        const avatarUrl = bareUploadUrl(payload.avatarUrl);
        if (!(await isValidStoredAvatar(avatarUrl))) {
          ack({ ok: false, error: "Некорректный аватар" });
          return;
        }
        if (!uploadOwnedBy(avatarUrl, bot.botId)) {
          ack({ ok: false, error: "Аватар загружен другим аккаунтом" });
          return;
        }
        avatarPatch.avatarUrl = avatarUrl;
      }

      let displayName = bot.displayName;
      if (payload?.displayName !== undefined || avatarPatch.avatarUrl !== undefined) {
        const updated = updateProfile(bot.botId, {
          ...(typeof payload?.displayName === "string"
            ? { displayName: payload.displayName }
            : {}),
          ...avatarPatch,
        });
        if (!updated.ok) {
          ack({ ok: false, error: updated.error });
          return;
        }
        displayName = updated.account.displayName;
        setBotDisplayName(bot.botId, displayName);
        bot.displayName = displayName;
      }

      if (payload?.description !== undefined) {
        const described = setBotDescription(bot.botId, payload.description);
        if (!described.ok) {
          ack({ ok: false, error: described.error });
          return;
        }
      }

      broadcastPeople(io);
      for (const chat of listChatsForUser(bot.botId)) {
        await notifyChatMembers(io, chat);
      }
      const record = findBot(bot.botId);
      ack({ ok: true, bot: record ? publicBot(record) : null });
    },
  );

  onBot("bot:voiceJoin", async (payload: { channelId?: string }, ack?: BotAck) => {
    if (typeof ack !== "function") return;
    if (!rateLimit(`bot-voice:${bot.botId}`, 20, 60_000)) {
      ack({ ok: false, error: "Слишком часто" });
      return;
    }
    const joined = botJoinVoice(io, socket, bot, payload?.channelId);
    if (!joined.ok) {
      ack({ ok: false, error: joined.error });
      return;
    }
    const livekit = await botVoiceCredentials(socket, bot, joined.channelId);
    ack({
      ...joined,
      livekit,
      ...(livekit
        ? {}
        : {
            warning:
              "LiveKit не настроен: бот виден в канале, но аудио/видео публиковать некуда",
          }),
    });
  });

  onBot("bot:voiceLeave", (_payload: unknown, ack?: BotAck) => {
    if (typeof ack !== "function") return;
    if (!rateLimit(`bot-voice:${bot.botId}`, 20, 60_000)) {
      ack({ ok: false, error: "Слишком часто" });
      return;
    }
    ack(botLeaveVoice(io, socket, bot));
  });

  onBot("bot:voiceMembers", (payload: { channelId?: string }, ack?: BotAck) => {
    if (typeof ack !== "function") return;
    const result = botVoiceMembers(bot.botId, payload?.channelId);
    if (!result) {
      ack({ ok: false, error: "Голосовой канал не найден" });
      return;
    }
    ack({ ok: true, ...result });
  });

  onBot(
    "bot:voiceMedia",
    (
      payload: {
        muted?: unknown;
        deafened?: unknown;
        cameraOff?: unknown;
        sharingScreen?: unknown;
      },
      ack?: BotAck,
    ) => {
      if (typeof ack !== "function") return;
      if (!rateLimit(`bot-voice:${bot.botId}`, 40, 60_000)) {
        ack({ ok: false, error: "Слишком часто" });
        return;
      }
      ack(botSetVoiceMedia(io, socket, bot, payload || {}));
    },
  );

  onBot(
    "bot:sendVoice",
    async (
      payload: { chatId?: string; file?: BotFileInput; replyToId?: string },
      ack?: BotAck,
    ) => {
      if (typeof ack !== "function") return;
      const access = botChatAccess(bot.botId, payload?.chatId);
      if (!access) {
        ack({ ok: false, error: "Бот не участник этого чата" });
        return;
      }
      if (!rateLimit(`bot-voice-msg:${bot.botId}`, 20, 60_000)) {
        ack({ ok: false, error: "Слишком много голосовых" });
        return;
      }
      const url = String(payload?.file?.url || "");
      const info = await getUploadInfo(url).catch(() => null);
      if (!info) {
        ack({ ok: false, error: "Файл не найден" });
        return;
      }
      if (!uploadOwnedBy(url, bot.botId)) {
        ack({ ok: false, error: "Файл загружен другим аккаунтом" });
        return;
      }
      const clientMime = String(payload?.file?.mime || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const mime = clientMime.startsWith("audio/")
        ? clientMime
        : info.mime || mimeFromName(info.fileName);
      if (!isAudioAttachment({ url, name: info.fileName, mime })) {
        ack({ ok: false, error: "Голосовое сообщение должно быть аудиофайлом" });
        return;
      }
      const extension = path.extname(info.fileName || "").toLowerCase() || ".ogg";
      const provided = sanitizeBotText(payload?.file?.name, 100);
      const name = /^voice[-_]/i.test(provided)
        ? provided
        : `voice-${Date.now()}${extension}`;
      const message: ChatMessage = {
        id: randomUUID(),
        room: access.roomId,
        author: bot.displayName,
        authorId: bot.botId,
        text: "Голосовое сообщение",
        createdAt: Date.now(),
        kind: "file",
        file: { url: bareUploadUrl(url), name, size: info.size, mime },
        replyTo: await resolveReply(access.roomId, payload?.replyToId, bot.botId),
      };
      await messageTasks.run(["room:" + access.roomId], async () => {
        await pushMessage(io, access.chat, message);
      });
      if (voiceAttachmentOf(message)) {
        await startVoiceTranscription(io, access.chat, message);
      }
      ack({ ok: true, messageId: message.id, url: message.file?.url });
    },
  );

  onBot("bot:typing", (payload: { chatId?: string; isTyping?: boolean }) => {
    const access = botChatAccess(bot.botId, payload?.chatId);
    if (!access) return;
    if (!rateLimit(`bot-typing:${bot.botId}`, 60, 10_000)) return;
    socket.to(access.roomId).emit("typing", {
      chatId: access.roomId,
      name: bot.displayName,
      isTyping: Boolean(payload?.isTyping),
    });
  });

  onBot("bot:chats", (_payload: unknown, ack?: BotAck) => {
    ack?.({ ok: true, chats: botChatSummaries(bot.botId) });
  });

  onBot(
    "bot:history",
    async (payload: { chatId?: string; before?: string }, ack?: BotAck) => {
      if (typeof ack !== "function") return;
      const access = botChatAccess(bot.botId, payload?.chatId);
      if (!access) {
        ack({ ok: false, error: "Бот не участник этого чата" });
        return;
      }
      if (!rateLimit(`bot-history:${bot.botId}`, 60, 60_000)) {
        ack({ ok: false, error: "Слишком много запросов" });
        return;
      }
      const page = await historyPage(
        access.roomId,
        bot.botId,
        String(payload?.before || "").slice(0, 200) || undefined,
      );
      ack({
        ok: true,
        chatId: access.roomId,
        messages: await publicMessages(page.messages, bot.botId),
        hasMore: page.hasMore,
        before: page.before,
      });
    },
  );

  onBot(
    "bot:joinGroup",
    async (payload: { code?: string }, ack?: BotAck) => {
      if (typeof ack !== "function") return;
      if (!rateLimit(`bot-join-group:${bot.botId}`, 10, 60_000)) {
        ack({ ok: false, error: "Слишком много попыток. Попробуйте через минуту." });
        return;
      }
      let joined: ReturnType<typeof joinGroupByCode>;
      try {
        joined = joinGroupByCode(bot.botId, String(payload?.code || ""));
      } catch {
        ack({ ok: false, error: "Не удалось проверить код. Попробуйте позже." });
        return;
      }
      if (!joined.ok) {
        ack({ ok: false, error: joined.error });
        return;
      }
      syncBotRooms(io, joined.chat);
      await notifyChatMembers(io, joined.chat);
      for (const memberId of joined.chat.memberIds) {
        emitToUser(io, memberId, "people", peopleForViewer(memberId));
      }
      ack({
        ok: true,
        already: joined.already,
        chat: botChatSummaries(bot.botId).find(
          (chat) => chat.id === joined.chat.id,
        ),
      });
    },
  );

  // Manual resync: after a restart a bot may be added to chats while offline.
  onBot("bot:join", (_payload: unknown, ack?: BotAck) => {
    joinAll();
    ack?.({ ok: true, chats: botChatSummaries(bot.botId) });
  });

  socket.on("disconnect", () => {
    leaveVoiceChannel(io, socket, bot.botId);
    unregisterBotSocket(bot.botId, socket.id);
    broadcastPeople(io);
  });
}

const BOT_ADMIN_BODY_LIMIT = 64 * 1024;

function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BOT_ADMIN_BODY_LIMIT) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null,
        );
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function botAdminJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

/**
 * Local bot administration used by `npm run bots:add`.
 * Auth is the machine-local secret (data/bot-admin-secret.txt or
 * BOT_ADMIN_SECRET), never a user session: bots are added manually by the owner.
 */
async function handleBotsAdmin(req: IncomingMessage, res: ServerResponse, io: Server) {
  if (req.method !== "POST") {
    botAdminJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!rateLimit(`bots-admin:${clientAddress(req)}`, 30, 60_000)) {
    botAdminJson(res, 429, { ok: false, error: "Слишком много запросов" });
    return;
  }
  if (!verifyBotAdminSecret(req.headers["x-bot-admin-secret"])) {
    botAdminJson(res, 403, { ok: false, error: "Нет доступа к управлению ботами" });
    return;
  }
  const body = await readSmallJson(req);
  if (!body) {
    botAdminJson(res, 400, { ok: false, error: "Неверный запрос" });
    return;
  }
  const action = String(body.action || "create");

  if (action === "list") {
    botAdminJson(res, 200, { ok: true, bots: listBots() });
    return;
  }

  if (action === "create") {
    const groupId = String(body.groupId || "").trim();
    let group = groupId ? getChat(groupId) : null;
    if (groupId && (!group || group.type !== "group")) group = findGroupByTitle(groupId);
    if (groupId && (!group || group.type !== "group")) {
      botAdminJson(res, 404, { ok: false, error: "Группа не найдена" });
      return;
    }
    const created = await createBot({
      displayName: body.displayName,
      username: body.username,
      bio: body.bio,
      avatarUrl: body.avatarUrl,
      ownerId: body.ownerId,
      description: body.description,
    });
    if (!created.ok) {
      botAdminJson(res, 400, { ok: false, error: created.error });
      return;
    }
    if (group) {
      const added = addGroupMember(group.id, created.bot.botId);
      if (!added.ok) {
        removeBot(created.bot.botId);
        botAdminJson(res, 400, { ok: false, error: added.error });
        return;
      }
      syncBotRooms(io, added.chat);
      await notifyChatMembers(io, added.chat);
    }
    botAdminJson(res, 200, {
      ok: true,
      bot: created.bot,
      token: created.token,
      ...(group ? { groupId: group.id } : {}),
    });
    return;
  }

  const target = String(body.botId || body.username || "").trim();
  const record = findBot(target) ?? findBotByUsername(target);
  if (!record) {
    botAdminJson(res, 404, { ok: false, error: "Бот не найден" });
    return;
  }

  if (action === "addToGroup") {
    const groupRaw = String(body.groupId || "").trim();
    let group = groupRaw ? getChat(groupRaw) : null;
    if (groupRaw && (!group || group.type !== "group")) group = findGroupByTitle(groupRaw);
    if (!group || group.type !== "group") {
      botAdminJson(res, 404, { ok: false, error: "Группа не найдена" });
      return;
    }
    const added = addGroupMember(group.id, record.botId);
    if (!added.ok) {
      botAdminJson(res, 400, { ok: false, error: added.error });
      return;
    }
    syncBotRooms(io, added.chat);
    await notifyChatMembers(io, added.chat);
    botAdminJson(res, 200, { ok: true, bot: publicBot(record), groupId: group.id });
    return;
  }

  if (action === "rotate") {
    const rotated = rotateBotToken(record.botId);
    if (!rotated.ok) {
      botAdminJson(res, 400, { ok: false, error: rotated.error });
      return;
    }
    // Old token must stop working right away: drop its live sockets.
    for (const socketId of [...botSocketIds(record.botId)]) {
      io.sockets.sockets.get(socketId)?.disconnect(true);
    }
    botAdminJson(res, 200, { ok: true, bot: rotated.bot, token: rotated.token });
    return;
  }

  if (action === "remove") {
    const chats = listChatsForUser(record.botId);
    const removed = removeBot(record.botId);
    if (!removed.ok) {
      botAdminJson(res, 400, { ok: false, error: removed.error });
      return;
    }
    removeMemberEverywhere(record.botId);
    for (const socketId of [...botSocketIds(record.botId)]) {
      io.sockets.sockets.get(socketId)?.disconnect(true);
    }
    botSocketsById.delete(record.botId);
    broadcastPeople(io);
    for (const chat of chats) {
      const live = getChat(chat.id);
      if (live) await notifyChatMembers(io, live);
    }
    botAdminJson(res, 200, { ok: true, bot: removed.bot });
    return;
  }

  botAdminJson(res, 400, { ok: false, error: "Неизвестное действие" });
}

function refreshPresenceName(io: Server, account: AuthAccount) {  for (const [socketId, presence] of usersBySocket.entries()) {
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

app.prepare().then(async () => {
  // Finish demo password hashing before accepting connections.
  if (process.env.SEED_DEMO === "1") {
    await ensureDemoUsers();
  }
  // Bots are added by hand: make sure the CLI secret exists before listening.
  try {
    botAdminSecret();
  } catch (error) {
    console.warn("[bots] cannot prepare admin secret", (error as Error).name);
  }
  if (messageStore) {
    await messageStore.connect();
    const rooms = await messageStore.initialize();
    console.log(`[messages] MongoDB ready: ${rooms} rooms, history loaded on demand`);
  }
  const httpServer = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
    const desktopUi = /^\/\?(?:[^#]*&)?_desktop_ui=1(?:&|$)/.test(req.url || "");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", desktopUi ? "SAMEORIGIN" : "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
    );
    const nonce = randomBytes(18).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
        "object-src 'none'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data: https://*.giphy.com https://media.giphy.com https://i.giphy.com",
        "media-src 'self' blob: https://*.giphy.com https://media.giphy.com",
        `connect-src 'self' blob: ws: wss: stun: turn: turns: https://*.giphy.com https://media.giphy.com https://i.giphy.com${s3Origin ? ` ${s3Origin}` : ""}`,
        "font-src 'self'",
        desktopUi ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    );
    // Next.js extracts this nonce when dynamically rendering its inline scripts.
    req.headers["content-security-policy"] = String(res.getHeader("Content-Security-Policy"));
    req.headers["x-nonce"] = nonce;
    if (!dev) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }

    const url = req.url || "";
    let pathname: string;
    try { pathname = new URL(url, "http://localhost").pathname; }
    catch { res.writeHead(400); res.end(); return; }
    if (pathname === "/api/gif") {
      const session = restoreSession(String(req.headers["x-pulse-token"] || ""));
      res.setHeader("Cache-Control", "private, no-store");
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      if (!session.ok) { res.writeHead(401); res.end(); return; }
      if (!rateLimit(`gif:${session.account.userId}`, 30, 60_000)
        || !rateLimit(`gif-ip:${clientAddress(req)}`, 60, 60_000)) {
        res.writeHead(429, { "Retry-After": "60" }); res.end(); return;
      }
      void getGifs(url).then(async response => {
        const body = await response.text();
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(body);
      }).catch(() => { if (!res.writableEnded) { res.statusCode = 503; res.end(); } });
      return;
    }
    if (tryServeDesktopUpdate(req, res)) return;
    if (
      !url.startsWith("/_next/") &&
      !url.startsWith("/uploads") &&
      !url.startsWith("/api/")
    ) {
      res.setHeader("Cache-Control", "no-store");
    }
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
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      const health = async () => {
        const ok = messageStore ? await messageStore.healthy() : true;
        res.statusCode = ok ? 200 : 503;
        const session = restoreSession(String(req.headers["x-pulse-token"] || ""));
        res.end(JSON.stringify(session.ok ? { ok, buildId: APP_BUILD_ID, desktopMediaHost: 1 } : { ok, desktopMediaHost: 1 }));
      };
      void health();
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
                    "SFU не настроен: нужен свой LiveKit на этой ВМ (не Cloud). Локально: livekit-server --dev",
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
      if (!rateLimit(`ice:${session.account.userId}`, 20, 60_000)) {
        res.writeHead(429, { "Retry-After": "60" }); res.end(); return;
      }
      const secret = readOptionalSecret(".turn-auth-secret", "TURN_AUTH_SECRET");
      if (secret.length < 32) {
        res.writeHead(503, { "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "TURN credentials are not configured" })); return;
      }
      const turn = issueTurnCredentials(secret, session.account.userId, token);
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
      res.setHeader("Cache-Control", "private, no-store");
      res.end(
        JSON.stringify({
          ok: true,
          expiresAt: turn.expiresAt,
          iceServers: buildIceServers({
            turnHost: host,
            turnUser: turn.username,
            turnPass: turn.credential,
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
      if (!rateLimit(`push-subscribe:${session.account.userId}`, 10, 60_000)) {
        res.writeHead(429, { "Retry-After": "60" }); res.end(); return;
      }
      const chunks: Buffer[] = [];
      let bodySize = 0;
      req.on("data", (chunk) => {
        bodySize += Buffer.byteLength(chunk);
        if (bodySize <= 8192) chunks.push(Buffer.from(chunk));
        else if (!res.writableEnded) { res.writeHead(413, { Connection: "close" }); res.end(); }
      });
      req.on("end", () => {
        if (res.writableEnded) return;
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
          if (!isAllowedPushEndpoint(endpoint)) {
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
          if (!validPushKeys({ p256dh, auth })) {
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
      void handleRingtones(req, res, (userId) => emitToUser(io, userId, "ringtone:changed", {}));
      return;
    }
    if (url.startsWith("/api/bots/admin")) {
      void handleBotsAdmin(req, res, io).catch((error: Error) => {
        console.error("[bots:admin]", error.name);
        botAdminJson(res, 500, { ok: false, error: "Не удалось выполнить действие с ботами" });
      });
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
    maxHttpBufferSize: 64 * 1024,
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

  const disposeDesktopNotifications = configureDesktopUpdateNotifications(io);
  httpServer.once("close", disposeDesktopNotifications);

  function clientKey(socket: Socket) { return clientAddress(socket.request); }

  async function recordDevice(socket: Socket, token: string) {
    await recordSessionAccess(token, {
      ip: clientKey(socket), userAgent: String(socket.request.headers["user-agent"] || ""),
    });
  }

  const admission = new MessageAdmission();
  setInterval(() => {
    const sample = admission.sample();
    if (sample.accepted || sample.rejected || sample.pending) {
      console.log("[messages:load]", JSON.stringify({ ...sample, msgPerSecond: sample.accepted / 60 }));
    }
    // Disconnect slow consumers so reliable Socket.IO buffers cannot grow forever.
    for (const client of io.sockets.sockets.values()) {
      if (isSocketBackedUp(client)) client.disconnect(true);
    }
  }, 1000 * 60).unref();
  io.use((socket, nextSocket) => {
    const ip = clientKey(socket);
    if (io.engine.clientsCount > 500 || !rateLimit(`socket-connect:${ip}`, 30, 60_000)
      || [...io.sockets.sockets.values()].filter(other => clientKey(other) === ip).length >= 12) {
      nextSocket(new Error("Too many connections")); return;
    }
    nextSocket();
  });

  // Bot processes authenticate once, at the handshake, with their token.
  // Everything else (session events, presence, calls) stays unavailable to them.
  io.use((socket, nextSocket) => {
    const auth = socket.handshake.auth as { botToken?: unknown } | undefined;
    const token = auth?.botToken;
    if (!token) {
      nextSocket();
      return;
    }
    if (!rateLimit(`bot-connect:${clientKey(socket)}`, 20, 60_000)) {
      nextSocket(new Error("Слишком много попыток подключения"));
      return;
    }
    const record = resolveBotToken(token);
    if (!record) {
      nextSocket(new Error("Неверный токен бота"));
      return;
    }
    socket.data.bot = {
      botId: record.botId,
      username: record.username,
      displayName: record.displayName,
    } satisfies BotSocketSession;
    nextSocket();
  });

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

  // Keep sending boot id so open tabs reload after PM2 restart even if they
  // missed the first `connection` packet (hung polling, background tab).
  setInterval(() => {
    io.emit("app:boot", { bootId: APP_BOOT_ID, buildId: APP_BUILD_ID });
  }, 3_000);

  io.on("connection", (socket) => {
    ioServer = io;
    monitorSocketBackpressure(socket);
    const botSession = botSessionOf(socket);
    if (botSession) {
      try {
        attachBotSocket(io, socket, botSession);
      } catch (error) {
        console.error("[bot:connect]", (error as Error).name);
        socket.disconnect(true);
      }
      return;
    }
    function on<Args extends unknown[]>(event: string, handler: (...args: Args) => unknown) {
      socket.on(event, (...args: Args) => {
        const action = async () => { await handler(...args); };
        const payload = args[0] as { chatId?: string; fromChatId?: string; toChatId?: string } | undefined;
        const roomKeys = [payload?.chatId, payload?.fromChatId, payload?.toChatId, usersBySocket.get(socket.id)?.room]
          .filter((key): key is string => typeof key === "string" && Boolean(key)).map(key => "room:" + key);
        const touchesMessages = /^(message|history:|chats:|dm:|auth:|invite:|room:media|call:log|join$|leave$|disconnect$)/.test(event);
        const task = /^(group:|text:)/.test(event)
          ? messageTasks.exclusive(action)
          : touchesMessages ? messageTasks.run(["socket:" + socket.id, ...roomKeys], action) : action();
        void task.catch((error: Error) => {
          console.error("[socket:" + event + "]", error.name);
          const ack = args[args.length - 1];
          if (typeof ack === "function") ack({ ok: false, error: "?? ??????? ????????? ??????. ????????? ???????." });
        });
      });
    }

    on("history:search", async (payload: { chatId?: string; query?: string; after?: string }, ack) => {
      if (typeof ack !== "function") return;
      const account = getSocketAccount(socket.id);
      const chatId = String(payload?.chatId || "").slice(0, 200);
      const chat = getChat(chatId);
      if (!account || !chat || !canAccessChat(chat, account.userId)) { ack({ ok: false, error: "Нет доступа" }); return; }
      if (!rateLimit(`history-search:${account.userId}`, 60, 60_000)) { ack({ ok: false, error: "Слишком много запросов" }); return; }
      const query = String(payload?.query || "").trim();
      if (query.length > 200) { ack({ ok: false, error: "Запрос слишком длинный (максимум 200 символов)" }); return; }
      const after = String(payload?.after || "").slice(0, 200) || undefined;
      try {
        const page = messageStore ? await messageStore.search(chatId, account.userId, query, after)
          : searchHistory(messagesFor(chatId), account.userId, query, after);
        ack({ ok: true, chatId, ...page });
      } catch { ack({ ok: false, error: "Не удалось выполнить поиск. Повторите запрос." }); }
    });

    on("history:load", async (payload: { chatId?: string; before?: string; after?: string; around?: string; all?: boolean }, ack) => {
      if (typeof ack !== "function") return;
      const account = getSocketAccount(socket.id);
      const chatId = String(payload?.chatId || "").slice(0, 200);
      const chat = getChat(chatId);
      if (!account || !chat || !canAccessChat(chat, account.userId)) { ack?.({ ok: false, error: "Нет доступа" }); return; }
      if (!rateLimit(`history:${account.userId}`, 60, 60_000)
        || (payload?.all && !rateLimit(`history-all:${account.userId}`, 12, 60_000))) {
        ack?.({ ok: false, error: "Слишком много запросов" }); return;
      }
      try {
        if (payload?.all) {
          ack?.({ ok: true, chatId, messages: await historyForClient(chatId, account.userId), hasMore: false, before: null });
        } else if (payload?.around || payload?.after) {
          const id = String(payload.around || payload.after).slice(0, 200);
          const page = payload.around
            ? messageStore ? await messageStore.window(chatId, account.userId, id) : selectHistoryWindow(messagesFor(chatId), account.userId, id)
            : messageStore ? await messageStore.newerPage(chatId, account.userId, id) : selectNewerHistory(messagesFor(chatId), account.userId, id);
          ack?.({ ok: true, chatId, ...page, messages: await publicMessages(page.messages, account.userId) });
        } else {
          const page = await historyPage(chatId, account.userId, String(payload?.before || "").slice(0, 200) || undefined);
          ack?.({ ok: true, chatId, ...page, messages: await publicMessages(page.messages, account.userId) });
        }
      } catch (error) { ack?.({ ok: false, error: (error as Error).message }); }
    });
    socket.use((packet, nextPacket) => {
      const event = String(packet[0]);
      const ackIndex = packet.length - 1;
      const acknowledge = packet[ackIndex];
      const reject = (error: string) => { if (typeof acknowledge === "function") acknowledge({ ok: false, error }); };
      if (!rateLimit(`socket-packets:${socket.id}`, 100, 10_000)) { reject("Слишком много запросов"); return; }
      if (!(event === "message" || event.startsWith("message:"))) { nextPacket(); return; }
      const account = getSocketAccount(socket.id);
      if (!account) { reject("Нужен вход"); return; }
      const payload = packet[1];
      const roomId = String(payload?.toChatId || payload?.chatId || usersBySocket.get(socket.id)?.room || "").slice(0, 200);
      const chat = getChat(roomId);
      if (!chat || !canAccessChat(chat, account.userId)) { reject("Нет доступа"); return; }
      if (event === "message:react") {
        if (!rateLimit(`reaction:${account.userId}`, 30, 60_000)
          || !rateLimit(`reaction-room:${roomId}`, 120, 60_000)) return;
        nextPacket(); return;
      }
      if (typeof acknowledge !== "function") return;
      const recipients = (io.sockets.adapter.rooms.get(roomId)?.size || 0) + chat.memberIds.length;
      if (chat.memberIds.length > 50 || recipients > 256 || isSocketBackedUp(socket)) {
        reject("Чат перегружен, повторите позже"); return;
      }
      const release = admission.acquire(account.userId, roomId, recipients);
      if (!release) { reject("Слишком много сообщений, повторите позже"); return; }
      const timeout = setTimeout(() => { release(); socket.disconnect(true); }, 15_000);
      timeout.unref();
      const cleanup = () => { clearTimeout(timeout); release(); };
      socket.once("disconnect", cleanup);
      let acknowledged = false;
      packet[ackIndex] = (result: unknown) => {
        if (acknowledged) return;
        acknowledged = true;
        socket.off("disconnect", cleanup);
        cleanup(); acknowledge(result);
      };
      nextPacket();
    });
    if (messageStore) {
      socket.use(async (packet, nextPacket) => {
        const ackIndex = packet.length - 1;
        const acknowledge = packet[ackIndex];
        if (typeof acknowledge === "function") {
          packet[ackIndex] = (result: { ok?: boolean; error?: string }) => {
            if (!result?.ok) { acknowledge(result); return; }
            void messageStore.idle().then(
              () => acknowledge(result),
              () => acknowledge({ ok: false, error: "Не удалось сохранить изменения. Повторите попытку." }),
            );
          };
        }
        if (/^(message|dm:delete|group:(delete|invite|leave)|invite:|text:delete|call:log)/.test(String(packet[0])) && !await messageStore.healthy()) {
          if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Хранилище сообщений временно недоступно" });
          return;
        }
        nextPacket();
      });
    }
    socket.emit("app:boot", { bootId: APP_BOOT_ID, buildId: APP_BUILD_ID });
    socket.emit("registration:policy", registrationPolicy());
    on("registration:invite", (_payload: unknown, ack?: (result: unknown) => void) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Сначала войдите" }); return; }
      if (!rateLimit(`registration-invite:${account.userId}`, 30, 60_000)) {
        ack?.({ ok: false, error: "Слишком много запросов. Попробуйте позже" }); return;
      }
      const member = getUserById(account.userId);
      if (!member) { ack?.({ ok: false, error: "Пользователь не найден" }); return; }
      ack?.({ ok: true, ...memberRegistrationInvite(member), ...registrationPolicy(),
        canManage: canManageRegistration(account.userId) });
    });
    on("registration:configure", (payload: { required?: unknown }, ack?: (result: unknown) => void) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Сначала войдите" }); return; }
      if (!rateLimit(`registration-configure:${account.userId}`, 12, 60_000)) {
        ack?.({ ok: false, error: "Слишком много запросов. Попробуйте позже" }); return;
      }
      const result = setRegistrationPolicy(account.userId, payload?.required);
      if (result.ok) io.emit("registration:policy", registrationPolicy());
      ack?.(result);
    });
    on("app:prepare-reload", (payload: { buildId?: string }, ack?: (result: { ok: boolean }) => void) => {
      const account = requireAccount(socket);
      if (!account || payload?.buildId !== APP_BUILD_ID) { ack?.({ ok: false }); return; }
      socket.data.reloadUntil = Date.now() + DEPLOY_RECONNECT_GRACE_MS;
      const callId = callByUser.get(account.userId);
      const call = callId ? callsById.get(callId) : undefined;
      if (call?.status === "active") {
        emitToUser(io, peerIdOfCall(call, account.userId), "call:reloading", { callId: call.callId });
      }
      // Presence and call IDs remain reserved; this is not call:end/voice:leave.
      persistLiveMedia();
      ack?.({ ok: true });
    });
    // people list only after auth — see afterAuth / broadcastPeople

    on("auth:devices", (_payload: unknown, ack?: (result: unknown) => void) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Сначала войдите" }); return; }
      if (!rateLimit(`devices-list:${account.userId}`, 60, 60_000)) {
        ack?.({ ok: false, error: "Слишком много запросов. Попробуйте позже" }); return;
      }
      ack?.(listDeviceSessions(account.token));
    });

    on("auth:device-revoke", (payload: { id?: unknown; others?: unknown }, ack?: (result: unknown) => void) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Сначала войдите" }); return; }
      if (!rateLimit(`devices-revoke:${account.userId}`, 20, 60_000)) {
        ack?.({ ok: false, error: "Слишком много запросов. Попробуйте позже" }); return;
      }
      const result = payload?.others === true
        ? revokeOtherDeviceSessions(account.token)
        : revokeDeviceSession(account.token, payload?.id);
      ack?.(result);
      if (result.ok) emitToUser(io, account.userId, "auth:devices-changed", {});
    });

    on(
      "auth:register",
      async (
        payload: { username?: string; password?: string; invitationCode?: unknown },
        ack?: (result: {
          ok: boolean;
          account?: AuthAccount;
          error?: string;
        }) => void,
      ) => {
        const invalid = authCredentialsError(payload?.username, payload?.password);
        if (invalid) { ack?.({ ok: false, error: invalid }); return; }
        if (!rateLimit(`register-attempt:${clientKey(socket)}`, 12, 60_000)) {
          ack?.({ ok: false, error: "Слишком много попыток, подождите" });
          return;
        }
        const result = await registerUser(
          String(payload?.username || ""),
          String(payload?.password || ""),
          clientKey(socket),
          payload?.invitationCode,
        );
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        await recordDevice(socket, result.account.token);
        if (!restoreSession(result.account.token).ok) { ack?.({ ok: false, error: "Сеанс завершён" }); return; }
        bindSocketAuth(socket.id, result.account.token);
        await afterAuth(io, socket, result.account);
        ack?.({ ok: true, account: publicAccount(result.account) });
        emitToUser(io, result.account.userId, "auth:devices-changed", {});
      },
    );

    on(
      "auth:login",
      async (
        payload: { username?: string; password?: string },
        ack?: (result: {
          ok: boolean;
          account?: AuthAccount;
          error?: string;
        }) => void,
      ) => {
        if (authCredentialsError(payload?.username, payload?.password)) {
          ack?.({ ok: false, error: "Неверный логин или пароль" }); return;
        }
        const loginKey = normalizeUsername(payload.username!).toLowerCase();
        if (!rateLimit(`login-name:${clientKey(socket)}:${loginKey}`, 8, 60_000)
          || !rateLimit(`login-ip:${clientKey(socket)}`, 60, 60_000)) {
          ack?.({ ok: false, error: "Слишком много попыток, подождите" });
          return;
        }
        const result = await loginUser(
          String(payload?.username || ""),
          String(payload?.password || ""),
        );
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        await recordDevice(socket, result.account.token);
        if (!restoreSession(result.account.token).ok) { ack?.({ ok: false, error: "Сеанс завершён" }); return; }
        bindSocketAuth(socket.id, result.account.token);
        await afterAuth(io, socket, result.account);
        ack?.({ ok: true, account: publicAccount(result.account) });
        emitToUser(io, result.account.userId, "auth:devices-changed", {});
      },
    );

    on(
      "auth:restore",
      async (
        payload: { token?: string },
        ack?: (result: {
          ok: boolean;
          account?: AuthAccount;
          error?: string;
        }) => void,
      ) => {
        if (!rateLimit(`restore:${clientKey(socket)}`, 120, 60_000)) {
          ack?.({ ok: false, error: "Слишком много попыток, подождите" });
          return;
        }
        const result = restoreSession(payload?.token);
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        await recordDevice(socket, result.account.token);
        if (!restoreSession(result.account.token).ok) { ack?.({ ok: false, error: "Сеанс завершён" }); return; }
        bindSocketAuth(socket.id, result.account.token);
        await afterAuth(io, socket, result.account);
        ack?.({ ok: true, account: publicAccount(result.account) });
      },
    );

    on("auth:logout", async () => {
      const account = getSocketAccount(socket.id);
      if (account) {
        const reconnectTimer = voiceDisconnectTimers.get(account.userId);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        voiceDisconnectTimers.delete(account.userId);
        leaveVoiceChannel(io, socket, account.userId);
        touchLastSeen(account.userId);
      }
      await leaveCurrentRoom(io, socket, true);
      usersBySocket.delete(socket.id);
      unbindSocketAuth(socket.id);
      logoutToken(account?.token);
      if (account) emitToUser(io, account.userId, "auth:devices-changed", {});
      broadcastPeople(io);
    });

    on(
      "profile:update",
      async (
        payload: {
          username?: string;
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
          if (!(await isValidStoredAvatar(avatarUrl))) {
            ack?.({ ok: false, error: "Некорректный аватар" });
            return;
          }
        }

        const result = updateProfile(account.userId, {
          username: payload?.username,
          displayName: payload?.displayName,
          bio: payload?.bio,
          avatarUrl,
        }, account.token);

        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }

        bindSocketAuth(socket.id, result.account.token || account.token);
        await afterAuth(io, socket, result.account);
        refreshPresenceName(io, result.account);
        for (const [socketId, presence] of usersBySocket) {
          if (presence.userId !== account.userId || socketId === socket.id) continue;
          const peerAccount = getSocketAccount(socketId);
          if (peerAccount) io.to(socketId).emit("profile:updated", publicAccount(peerAccount));
        }
        for (const chat of listChatsForUser(result.account.userId)) {
          await notifyChatMembers(io, chat);
        }
        ack?.({ ok: true, account: publicAccount(result.account) });
      },
    );

    on(
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

    on(
      "people:suggest",
      (
        _payload: { query?: string } | undefined,
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
        ack?.({ ok: true, users: suggestPeople(account.userId, String(_payload?.query || "")) });
      },
    );

    on(
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

    on(
      "group:join",
      async (
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
        syncBotRooms(io, joined.chat);
        await notifyChatMembers(io, joined.chat);
        for (const memberId of joined.chat.memberIds) {
          emitToUser(io, memberId, "people", peopleForViewer(memberId));
        }
        const result = await joinChat(io, socket, account, joined.chat.id);
        ack?.(result);
      },
    );

    on("group:code", (payload: { groupId?: string }, ack?: (result: ReturnType<typeof getGroupInviteCode>) => void) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Сначала войдите в аккаунт" }); return; }
      if (!rateLimit(`group-code:${account.userId}`, 30, 60_000)) {
        ack?.({ ok: false, error: "Слишком много запросов" }); return;
      }
      try {
        ack?.(getGroupInviteCode(String(payload?.groupId || ""), account.userId));
      } catch {
        ack?.({ ok: false, error: "Не удалось получить код. Попробуйте позже." });
      }
    });

    on("group:join-code", async (payload: { code?: string }, ack?: (result: { ok: boolean; session?: { name: string; room: string }; error?: string }) => void) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Сначала войдите в аккаунт" }); return; }
      if (!rateLimit(`group-code-join:${account.userId}`, 10, 60_000) ||
          !rateLimit(`group-code-join-ip:${clientKey(socket)}`, 30, 60_000)) {
        ack?.({ ok: false, error: "Слишком много попыток. Попробуйте через минуту." }); return;
      }
      let joined: ReturnType<typeof joinGroupByCode>;
      try {
        joined = joinGroupByCode(account.userId, String(payload?.code || ""));
      } catch {
        ack?.({ ok: false, error: "Не удалось проверить код. Попробуйте позже." }); return;
      }
      if (!joined.ok) { ack?.({ ok: false, error: joined.error }); return; }
      syncBotRooms(io, joined.chat);
      await notifyChatMembers(io, joined.chat);
      for (const memberId of joined.chat.memberIds) {
        emitToUser(io, memberId, "people", peopleForViewer(memberId));
      }
      ack?.(await joinChat(io, socket, account, joined.chat.id));
    });

    on(
      "dm:delete",
      async (
        payload: { chatId?: string; scope?: "self" | "both" },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        if (!account) { ack?.({ ok: false, error: "Сначала войдите в аккаунт" }); return; }
        if (!rateLimit(`dm-delete:${account.userId}`, 12, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" }); return;
        }
        const chatId = String(payload?.chatId || "");
        if (payload?.scope !== "self" && payload?.scope !== "both") {
          ack?.({ ok: false, error: "Выберите способ удаления" }); return;
        }
        const result = hideDm(chatId, account.userId, payload.scope === "both");
        if (!result.ok) { ack?.({ ok: false, error: result.error }); return; }
        if (payload.scope === "both") clearChatMessages(chatId);
        else if (messageStore) messageStore.hide(chatId, account.userId);
        else {
          const changed = messagesFor(chatId).filter(message => messageVisibleTo(message, account.userId));
          hideHistoryFor(changed, account.userId);
          if (changed.length) persistMessages(changed);
        }
        for (const userId of result.affectedIds) {
          pinnedByUser.get(userId)?.delete(chatId);
          markChatRead(userId, chatId);
          for (const socketId of socketsForUser(userId)) {
            const client = io.sockets.sockets.get(socketId);
            if (!client) continue;
            if (usersBySocket.get(socketId)?.room === chatId) await leaveCurrentRoom(io, client);
            client.emit("chat:left", { chatId });
          }
        }
        persistPins();
        await notifyChatMembers(io, result.chat);
        ack?.({ ok: true });
      },
    );

    on(
      "group:leave",
      async (
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

        await messageStore?.forgetViewerSummaries([chatId, ...(left.chat.textChannels || []).map(channel => channel.id)], account.userId);

        kickUserFromGroup(io, account.userId, chatId);
        if (left.chat.memberIds.length === 0) {
          clearChatMessages(chatId);
          for (const channel of left.chat.textChannels || []) clearChatMessages(channel.id);
          await expireInvitesForGroup(io, chatId, left.chat.title);
          for (const channel of left.chat.voiceChannels || []) {
            for (const member of voiceByChannel.get(channel.id)?.values() || []) {
              io.to(member.socketId).emit("voice:kick", { channelId: channel.id, reason: "channel-closed" });
            }
            void deleteLiveKitRoom(channel.id);
            clearVoiceChannelPresence(channel.id);
          }
        }
        await notifyChatMembers(io, left.chat);
        for (const memberId of left.chat.memberIds) {
          emitToUser(io, memberId, "people", peopleForViewer(memberId));
        }
        for (const socketId of socketsForUser(account.userId)) {
          const memberSocket = io.sockets.sockets.get(socketId);
          if (memberSocket) await emitChats(memberSocket, account.userId);
        }

        ack?.({ ok: true });
      },
    );

    on(
      "group:visibility",
      async (
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
        await notifyChatMembers(io, updated.chat);
        ack?.({ ok: true });
      },
    );

    on(
      "join",
      async (
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
        const result = await joinChat(
          io,
          socket,
          account,
          String(payload?.room || "lobby"),
        );
        ack?.(result);
      },
    );

    on(
      "dm:open",
      async (
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

        syncBotRooms(io, opened.chat);
        await notifyChatMembers(io, opened.chat);
        const result = await joinChat(io, socket, account, opened.chat.id);
        ack?.(result);
      },
    );

    on(
      "group:create",
      async (
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

        await notifyChatMembers(io, created.chat);
        const result = await joinChat(io, socket, account, created.chat.id);
        ack?.(result);
      },
    );

    // Older clients must use the same daily-code flow as the current UI.
    on("group:invite", (_payload: unknown, ack?: (result: { ok: boolean; error: string }) => void) => {
      ack?.({ ok: false, error: "Приглашайте по коду группы" });
    });

    on(
      "group:invite:respond",
      async (
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

        const message = await findMessage(chatId, messageId, account.userId);
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
          persistMessages([message]);
          await emitRoomMessage(io, "message:update", message);
          await notifyChatMembers(io, dm);
          ack?.({ ok: true });
          return;
        }

        const invitedGroup = getChat(message.invite.groupId);
        if (invitedGroup && groupVisibility(invitedGroup) === "private") {
          ack?.({ ok: false, error: "Для вступления в закрытую группу нужен актуальный код приглашения" });
          return;
        }

        const added = addGroupMember(message.invite.groupId, account.userId);
        if (!added.ok) {
          // Group may have been deleted while the invite was still pending.
          if (added.error === "Группа не найдена") {
            message.invite = { ...message.invite, status: "expired" };
            message.text = `Группа «${message.invite.groupTitle}» удалена`;
            persistMessages([message]);
            await emitRoomMessage(io, "message:update", message);
            await notifyChatMembers(io, dm);
            ack?.({ ok: false, error: "Группа удалена" });
            return;
          }
          ack?.({ ok: false, error: added.error });
          return;
        }

        message.invite = { ...message.invite, status: "accepted" };
        message.text = `Принято: «${message.invite.groupTitle}»`;
        persistMessages([message]);
        await emitRoomMessage(io, "message:update", message);
        await notifyChatMembers(io, dm);
        syncBotRooms(io, added.chat);
        await notifyChatMembers(io, added.chat);
        ack?.({ ok: true, groupId: added.chat.id });
      },
    );

    on(
      "group:delete",
      async (
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

        clearChatMessages(chatId);
        for (const channel of deleted.chat.textChannels || []) clearChatMessages(channel.id);
        await expireInvitesForGroup(io, chatId, deleted.chat.title);
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
        io.to(chatId).emit("chat:deleted", { chatId });
        kickSocketsFromChat(io, chatId);

        // Refresh chat lists for former members (chat already removed).
        for (const memberId of deleted.chat.memberIds) {
          for (const socketId of socketsForUser(memberId)) {
            const memberSocket = io.sockets.sockets.get(socketId);
            if (memberSocket) await emitChats(memberSocket, memberId);
          }
        }

        ack?.({ ok: true });
      },
    );

    on(
      "group:avatar",
      async (
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
          if (!(await isValidStoredAvatar(avatarUrl))) {
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

        await notifyChatMembers(io, updated.chat);
        ack?.({ ok: true });
      },
    );

    on(
      "group:update",
      async (
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

        await notifyChatMembers(io, updated.chat);
        ack?.({ ok: true });
      },
    );

  on("sticker:list", (_payload: unknown, ack?: (r: { ok: boolean; packs?: unknown[] }) => void) => {
    const account = requireAccount(socket);
    if (!account) { ack?.({ ok: false }); return; }
    ack?.({ ok: true, packs: listPacksForUser(account.userId) });
  });

  on(
    "sticker:pack:get",
    (
      payload: { packId?: string },
      ack?: (r: { ok: boolean; pack?: unknown; error?: string }) => void,
    ) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Нужен вход" }); return; }
      const pack = getStickerPack(String(payload?.packId || ""), account.userId);
      if (!pack) { ack?.({ ok: false, error: "Пак не найден" }); return; }
      ack?.({ ok: true, pack });
    },
  );

  on(
    "sticker:pack:create",
    (
      payload: { title?: string },
      ack?: (r: { ok: boolean; pack?: unknown; error?: string }) => void,
    ) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Нужен вход" }); return; }
      if (!rateLimit(`sticker-pack:${account.userId}`, 20, 60_000)) {
        ack?.({ ok: false, error: "Слишком часто" }); return;
      }
      const result = createStickerPack(account.userId, String(payload?.title || ""));
      if (!result.ok) { ack?.({ ok: false, error: result.error }); return; }
      ack?.({ ok: true, pack: result.pack });
    },
  );

  on(
    "sticker:pack:update",
    (
      payload: { packId?: string; title?: string },
      ack?: (r: { ok: boolean; pack?: unknown; error?: string }) => void,
    ) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Нужен вход" }); return; }
      const result = updatePackTitle(
        String(payload?.packId || ""),
        account.userId,
        String(payload?.title || ""),
      );
      if (!result.ok) { ack?.({ ok: false, error: result.error }); return; }
      ack?.({ ok: true, pack: result.pack });
    },
  );

  on(
    "sticker:pack:delete",
    (
      payload: { packId?: string },
      ack?: (r: { ok: boolean; error?: string }) => void,
    ) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Нужен вход" }); return; }
      const result = deleteStickerPack(
        String(payload?.packId || ""),
        account.userId,
      );
      if (!result.ok) { ack?.({ ok: false, error: result.error }); return; }
      ack?.({ ok: true });
    },
  );

  on(
    "sticker:pack:add",
    (
      payload: {
        packId?: string;
        url?: string;
        name?: string;
        emoji?: string;
        animated?: boolean;
        width?: number;
        height?: number;
        size?: number;
      },
      ack?: (r: { ok: boolean; sticker?: unknown; error?: string }) => void,
    ) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Нужен вход" }); return; }
      if (!rateLimit(`sticker-add:${account.userId}`, 60, 60_000)) {
        ack?.({ ok: false, error: "Слишком часто" }); return;
      }
      const result = addStickerToPack(String(payload?.packId || ""), account.userId, {
        url: String(payload?.url || ""),
        name: payload?.name,
        emoji: payload?.emoji,
        animated: payload?.animated,
        width: payload?.width,
        height: payload?.height,
        size: Number(payload?.size) || 0,
      });
      if (!result.ok) { ack?.({ ok: false, error: result.error }); return; }
      ack?.({ ok: true, sticker: result.sticker });
    },
  );

  on(
    "sticker:pack:remove",
    (
      payload: { packId?: string; stickerId?: string },
      ack?: (r: { ok: boolean; error?: string }) => void,
    ) => {
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Нужен вход" }); return; }
      const result = removeStickerFromPack(
        String(payload?.packId || ""),
        account.userId,
        String(payload?.stickerId || ""),
      );
      if (!result.ok) { ack?.({ ok: false, error: result.error }); return; }
      ack?.({ ok: true });
    },
  );

  on(
  "sticker:pack:install",
    (
      payload: { packId?: string },
      ack?: (r: { ok: boolean; already?: boolean; error?: string }) => void,
    ) => {
      const account = requireAccount(socket);
      if (!account) {
        ack?.({ ok: false, error: "Нужен вход" });
        return;
      }

      // Жёсткий cast снимает любые расхождения типов между файлами.
      const result = installStickerPack(
        account.userId,
        String(payload?.packId || ""),
      ) as { ok: boolean; already?: boolean; error?: string };

      if (!result.ok) {
        ack?.({ ok: false, error: result.error || "Не удалось добавить пак" });
        return;
      }
      ack?.({ ok: true, already: Boolean(result.already) });
    },
  );

  on(
    "sticker:pack:uninstall",
    (
      payload: { packId?: string },
      ack?: (r: { ok: boolean; error?: string }) => void,
    ) => {
      const account = requireAccount(socket);
      if (!account) {
        ack?.({ ok: false, error: "Нужен вход" });
        return;
      }
      uninstallStickerPack(account.userId, String(payload?.packId || ""));
      ack?.({ ok: true });
    },
  );

  on(
    "message:sticker",
    async (
      payload: {
        chatId?: string;
        packId?: string;
        stickerId?: string;
        replyToId?: string;
      },
      ack?: (result: { ok: boolean; message?: ChatMessage; error?: string }) => void,
    ) => {
      const presence = usersBySocket.get(socket.id);
      const account = requireAccount(socket);
      if (!account) { ack?.({ ok: false, error: "Нужен вход" }); return; }
      if (!rateLimit(`msg:${account.userId}`, 60, 60_000)) {
        ack?.({ ok: false, error: "Слишком много сообщений" }); return;
      }
      const chatId = String(payload?.chatId || presence?.room || "");
      if (!chatId || !presence?.room || presence.room !== chatId) {
        ack?.({ ok: false, error: "Нет активного чата" }); return;
      }
      const chat = getChat(chatId);
      if (!chat || !canAccessChat(chat, account.userId)) {
        ack?.({ ok: false, error: "Нет доступа" }); return;
      }
      const packId = String(payload?.packId || "");
      const stickerId = String(payload?.stickerId || "");
      if (!packId || !stickerId) {
        ack?.({ ok: false, error: "Стикер не найден" }); return;
      }
      if (!canSendSticker(account.userId, packId)) {
        ack?.({ ok: false, error: "Сначала добавьте пак" }); return;
      }
      const found = findSticker(packId, stickerId);
      if (!found) { ack?.({ ok: false, error: "Стикер не найден" }); return; }

      const message: ChatMessage = {
        id: randomUUID(),
        room: chatId,
        author: labelOf(account),
        authorId: account.userId,
        text: "Стикер",
        createdAt: Date.now(),
        kind: "sticker",
        sticker: {
          packId,
          stickerId,
          url: bareUploadUrl(found.sticker.url),
          animated: Boolean(found.sticker.animated),
          width: found.sticker.width,
          height: found.sticker.height,
        },
        replyTo: await resolveReply(chatId, payload?.replyToId, account.userId),
      };
      await pushMessage(io, chat, message);
      ack?.({ ok: true, message: await publicMessage(message, account.userId) });
    },
  );

    on(
      "room:media",
      async (
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
        const limit = Math.floor(Math.min(
          Math.max(Number(payload?.limit) || 48, 1),
          100,
        ));
        const offset = Math.floor(Math.max(Number(payload?.offset) || 0, 0));
        const page = await collectRoomMedia(chatId, kind, account.userId, offset, limit);
        ack?.({
          ok: true,
          ...page,
        });
      },
    );

    on(
      "chats:switch",
      async (
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
        const result = await joinChat(
          io,
          socket,
          account,
          String(payload?.chatId || "lobby"),
        );
        ack?.(result);
      },
    );

    on(
      "message",
      async (
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

        const rawClientId = String(payload?.clientId || "").slice(0, 80);
        const clientId = /^[a-zA-Z0-9_-]+$/.test(rawClientId)
          ? rawClientId
          : "";
        // Cross-restart dedupe: the in-memory idempotency map dies with the
        // process, so also match persisted messages by clientId.
        if (clientId) {
          const duplicate = await findClientMessage(presence.room!, account.userId, clientId, account.userId);
          if (duplicate) {
            ack?.({ ok: true, message: await publicMessage(duplicate, account.userId) });
            return;
          }
        }

        const { id, existing } = await resolveClientMessageId(
          account.userId,
          rawClientId,
          (messageId) => findMessage(presence.room!, messageId, account.userId),
        );
        if (existing) {
          ack?.({ ok: true, message: await publicMessage(existing, account.userId) });
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
          clientId: clientId || undefined,
          replyTo: await resolveReply(presence.room, payload?.replyToId, account.userId),
        };
        await pushMessage(io, chat, message);
        socket.to(presence.room).emit("typing", {
          chatId: presence.room,
          name: labelOf(account),
          isTyping: false,
        });
        ack?.({ ok: true, message: await publicMessage(message, account.userId) });
      },
    );

    on("chats:read", async (payload: { chatId?: string }) => {
      const account = requireAccount(socket);
      const chatId = String(payload?.chatId || "");
      if (!account || !chatId) return;
      if (!rateLimit(`chat-read:${account.userId}`, 40, 60_000)) return;
      const chat = getChat(chatId);
      if (!chat || !canAccessChat(chat, account.userId)) return;
      const before = lastReadByUser.get(account.userId)?.get(chatId) ?? 0;
      const readAt = markChatRead(account.userId, chatId);
      if (socket.handshake.auth?.chatPatches === 1) socket.emit("chat:update", await chatUpdateFor(chat, account.userId));
      else await emitChats(socket, account.userId);
      if (readAt === before) return; // nothing advanced — skip broadcast
      socket.to(chatId).emit("chat:read", {
        chatId,
        userId: account.userId,
        readAt,
      });
    });

    on(
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
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите" });
          return;
        }
        if (!chatId) {
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

    on(
      "chats:pin",
      async (
        payload: { chatId?: string },
        ack?: (result: { ok: boolean; pinned?: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        if (!account) {
          ack?.({ ok: false, error: "Сначала войдите" });
          return;
        }
        if (!chatId) {
          ack?.({ ok: false, error: "Нет чата" });
          return;
        }
        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        const pinned = togglePinned(account.userId, chatId);
        await emitChats(socket, account.userId);
        ack?.({ ok: true, pinned });
      },
    );

    on(
      "message:react",
      async (
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

        const message = await findMessage(chatId, messageId, account.userId);
        if (!message || message.kind === "system") {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }

        const updated = toggleReaction(message, account.userId, emoji);
        persistMessages([updated]);
        await emitRoomMessage(io, "message:update", updated);
        ack?.({ ok: true });
      },
    );

    on(
      "message:button",
      async (
        payload: { chatId?: string; messageId?: string; data?: string },
        ack?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const account = requireAccount(socket);
        const chatId = String(payload?.chatId || "");
        const messageId = String(payload?.messageId || "");
        const data = String(payload?.data || "");
        if (!account || !chatId || !messageId || !data || data.length > 64) {
          ack?.({ ok: false, error: "Некорректный запрос" });
          return;
        }
        if (!rateLimit(`msg-button:${account.userId}`, 40, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }
        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        const roomId = messageRoomFor(chat, chatId);
        const message = await findMessage(roomId, messageId, account.userId);
        const button = message?.buttons
          ?.flat()
          .find((item) => item.data && item.data === data);
        const botRecord = message?.authorId ? findBot(message.authorId) : undefined;
        if (!message || !button?.data || !botRecord) {
          ack?.({ ok: false, error: "Кнопка недоступна" });
          return;
        }
        // The bot answers asynchronously (edit the message or send a new one),
        // so the click itself only delivers the callback.
        const delivered = emitToBotSockets(io, botRecord.botId, "bot:callback", {
          chatId: roomId,
          chatType: chat.type,
          messageId: message.id,
          messageText: message.text,
          data: button.data,
          from: {
            id: account.userId,
            name: labelOf(account),
            username: account.username,
          },
        });
        if (!delivered) {
          ack?.({ ok: false, error: "Бот сейчас не в сети — попробуйте позже" });
          return;
        }
        ack?.({ ok: true });
      },
    );

    on(
      "message:delete",
      async (
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

        const message = await findMessage(chatId, messageId, account.userId);
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

        const redacted = await redactMessage(chatId, messageId);
        if (!redacted) {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }

        await emitRoomMessage(io, "message:update", redacted.tombstone);
        for (const updated of redacted.replyUpdates) {
          await emitRoomMessage(io, "message:update", updated);
        }
        // Legacy clients still listening for hard-delete.
        io.to(chatId).emit("message:deleted", {
          chatId,
          messageId,
          tombstone: await publicMessage(redacted.tombstone),
        });
        await notifyChatMembers(io, chat);
        ack?.({ ok: true });
      },
    );

    on(
      "message:edit",
      async (
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
        const message = await findMessage(chatId, messageId, account.userId);
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
        persistMessages([message]);
        await emitRoomMessage(io, "message:update", message);
        await notifyChatMembers(io, chat);
        ack?.({ ok: true });
      },
    );

    on(
      "message:pin",
      async (
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
        const message = await findMessage(chatId, messageId, account.userId);
        if (!message || message.kind === "system") {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }
        const nextPinned = !message.pinned;
        const previouslyPinned: ChatMessage[] = [];
        for await (const item of scanMessages(chatId, account.userId, false, { "message.pinned": true })) {
          if (!item.pinned || item.id === messageId) continue;
          item.pinned = false;
          previouslyPinned.push(item);
        }
        message.pinned = nextPinned;
        persistMessages([message, ...previouslyPinned]);
        await emitRoomMessage(io, "message:update", message);
        for (const item of previouslyPinned) {
          await emitRoomMessage(io, "message:update", item);
        }
        ack?.({ ok: true, pinned: nextPinned });
      },
    );

    on(
      "message:forward",
      async (
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
        const source = await findMessage(fromChatId, messageId, account.userId);
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
          sticker: source.sticker,
          transcription: source.transcription,
          transcriptionStatus: source.transcriptionStatus,
          forwardedFrom: {
            author: source.author,
            text: source.text?.slice(0, 120),
          },
        };
        await pushMessage(io, toChat, message);
        ack?.({ ok: true });
      },
    );

    on(
      "message:file",
      async (
        payload: {
          chatId?: string;
          clientId?: string;
          file?: {
            url?: string;
            name?: string;
            size?: number;
            mime?: string;
            width?: number;
            height?: number;
          };
          files?: {
            url?: string;
            name?: string;
            size?: number;
            mime?: string;
            width?: number;
            height?: number;
          }[];
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

        const rawClientId = String(payload?.clientId || "").slice(0, 80);
        const clientId = /^[a-zA-Z0-9_-]+$/.test(rawClientId)
          ? rawClientId
          : "";
        if (clientId) {
          const duplicate = await findClientMessage(chatId, account.userId, clientId);
          if (duplicate) {
            ack?.({ ok: true });
            return;
          }
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
          width?: number;
          height?: number;
        }[] = [];

        for (const file of rawList) {
          const url = String(file?.url || "");
          const remote = parseGiphyMediaUrl(url);
          if (remote) {
            const safeFileName = String(file?.name || remote.name)
              .replace(/[\u0000-\u001F\u007F]/g, "")
              .slice(0, 120) || remote.name;
            resolved.push({
              url: remote.url,
              name: safeFileName,
              size: Math.max(0, Math.min(Number(file?.size) || 0, 20 * 1024 * 1024)),
              mime: remote.mime,
              isAudio: false,
              ...parseMediaSize(file),
            });
            continue;
          }

          let stored;
          try {
            stored = await getUploadInfo(url);
          } catch {
            ack?.({ ok: false, error: "Хранилище временно недоступно" });
            return;
          }
          if (!file?.name || !stored) {
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
          const fromName = stored.mime || mimeFromName(stored.fileName);
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
          if (!uploadOwnedBy(url, account.userId)) {
            ack?.({ ok: false, error: "Файл вам не принадлежит" });
            return;
          }

          const size = stored.size;

          resolved.push({
            url: bareUploadUrl(url),
            name: safeFileName,
            size,
            mime: serverMime,
            isAudio,
            ...parseMediaSize(file),
          });
        }

        const attachments = await Promise.all(resolved.map(async ({ url, name, size, mime, width, height }) => {
          const microPreview = await getUploadMicroPreview({ url, name, size, mime });
          return { url, name, size, mime, ...(width && height ? { width, height } : {}),
            ...(microPreview ? { microPreview } : {}) };
        }));

        // Storage/preview work yields to socket events; recheck access and deduplication.
        if (!canAccessChat(chat, account.userId) || getSocketAccount(socket.id)?.userId !== account.userId) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        if (clientId && (await findClientMessage(chatId, account.userId, clientId))) {
          ack?.({ ok: true });
          return;
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

        const saved: ChatMessage = {
          id: randomUUID(),
          room: chatId,
          author: labelOf(account),
          authorId: account.userId,
          text: text.slice(0, 200),
          clientId: clientId || undefined,
          createdAt: Date.now(),
          kind: "file",
          file: attachments[0],
          files: attachments.length > 1 ? attachments : undefined,
          replyTo: await resolveReply(chatId, payload?.replyToId, account.userId),
        };
        await pushMessage(io, chat, saved);
        if (voiceAttachmentOf(saved)) {
          await startVoiceTranscription(io, chat, saved);
        }
        ack?.({ ok: true });
      },
    );

    on(
      "message:transcribe",
      async (
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
        if (!rateLimit(`msg-transcribe:${account.userId}`, 20, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }
        const chat = getChat(chatId);
        if (!chat || !canAccessChat(chat, account.userId)) {
          ack?.({ ok: false, error: "Нет доступа" });
          return;
        }
        const message = await findMessage(chatId, messageId, account.userId);
        if (
          !message ||
          message.kind === "system" ||
          message.kind === "call" ||
          message.kind === "sticker"
        ) {
          ack?.({ ok: false, error: "Сообщение не найдено" });
          return;
        }
        if (!hasTranscriptionKey()) {
          ack?.({ ok: false, error: "Расшифровка недоступна" });
          return;
        }
        await startVoiceTranscription(io, chat, message, {
          force: message.transcriptionStatus === "error",
        });
        ack?.({ ok: true });
      },
    );

    on("typing", (isTyping: boolean) => {
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

    on(
      "call:invite",
      (
        payload: {
          toUserId?: string;
          mode?: "audio" | "video";
          chatId?: string;
          reconnect?: boolean;
          callId?: string;
        },
        ack?: (result: {
          ok: boolean;
          callId?: string;
          resume?: boolean;
          role?: "caller" | "callee";
          peerPresent?: boolean;
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
        if (isBotUserId(toUserId)) {
          ack?.({ ok: false, error: "Боты не принимают звонки" });
          return;
        }
        const onlineSockets = socketsForUser(toUserId);
        const canReachPush = hasPushSubscription(toUserId);
        if (!reconnect && !onlineSockets.length && !canReachPush) {
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
            (!payload.callId || payload.callId === existingPair.callId) &&
            callByUser.get(toUserId) === existingPair.callId;
          if (canResume) {
            cancelCallDisconnectTimer(account.userId);
            callByUser.set(account.userId, existingPair.callId);
            ack?.({
              ok: true,
              callId: existingPair.callId,
              resume: true,
              role: existingPair.callerId === account.userId ? "caller" : "callee",
              peerPresent: userIsConnected(toUserId),
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
          if (!reconnect) clearCall(existingPair.callId);
        }
        if (reconnect) {
          // A stale reload snapshot must never create a new ringing call.
          ack?.({ ok: false, error: "Звонок уже завершён" });
          return;
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
              fromName: "Майко",
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

    on(
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

    on(
      "call:log",
      async (payload: { chatId?: string; text?: string }) => {
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
        await pushMessage(io, chat, {
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

    on("leave", async () => {
      await leaveCurrentRoom(io, socket);
      broadcastPeople(io);
    });

    on(
      "voice:create",
      async (
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
        await notifyChatMembers(io, created.chat);
        ack?.({
          ok: true,
          channel: { id: created.channel.id, title: created.channel.title },
        });
      },
    );

    on(
      "voice:delete",
      async (
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
        await notifyChatMembers(io, deleted.chat);
        ack?.({ ok: true });
      },
    );

    on(
      "text:create",
      async (
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
        if (!rateLimit(`text-create:${account.userId}`, 20, 60_000)) {
          ack?.({ ok: false, error: "Слишком часто" });
          return;
        }
        const created = createTextChannel(
          String(payload?.groupId || ""),
          account.userId,
          String(payload?.title || ""),
        );
        if (!created.ok) {
          ack?.({ ok: false, error: created.error });
          return;
        }
        await notifyChatMembers(io, created.chat);
        ack?.({
          ok: true,
          channel: { id: created.channel.id, title: created.channel.title },
        });
      },
    );

    on(
      "text:delete",
      async (
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
        const deleted = deleteTextChannel(groupId, channelId, account.userId);
        if (!deleted.ok) {
          ack?.({ ok: false, error: deleted.error });
          return;
        }
        clearChatMessages(channelId);
        for (const [socketId, presence] of usersBySocket.entries()) {
          if (presence.room !== channelId || !presence.userId) continue;
          const memberSocket = io.sockets.sockets.get(socketId);
          const member = getSocketAccount(socketId);
          if (memberSocket && member) {
            memberSocket.emit("chat:moved", { room: groupId });
            await joinChat(io, memberSocket, member, groupId);
          }
        }
        await notifyChatMembers(io, deleted.chat);
        ack?.({ ok: true });
      },
    );

    on(
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

    on(
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

    on(
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
        if (!rateLimit(`voice-mute:${account.userId}`, 12, 10_000)) {
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

    on(
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
        if (!rateLimit(`voice-deafen:${account.userId}`, 12, 10_000)) {
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

    on(
      "voice:speaking",
      (payload: { speaking?: boolean }) => {
        const account = requireAccount(socket);
        if (!account) return;
        if (!rateLimit(`voice-speaking:${account.userId}`, 20, 10_000)) {
          return;
        }
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

    on(
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

    on("voice:signal", () => {
      // Group channels are always LiveKit SFU. Mesh signaling is never relayed.
    });

    on("disconnect", async () => {
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
            }, Math.max(VOICE_RECONNECT_GRACE_MS, Number(socket.data.reloadUntil || 0) - Date.now())),
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
              }, Math.max(CALL_RECONNECT_GRACE_MS, Number(socket.data.reloadUntil || 0) - Date.now())),
            );
          }
        }
        touchLastSeen(account.userId);
      }
      await leaveCurrentRoom(io, socket);
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
    console.log(`> Майко ready on http://${hostname}:${port}`);
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
    httpServer.close();
    io.close();
    const deadline = setTimeout(() => {
      console.error("[shutdown] persistence deadline exceeded");
      process.exit(1);
    }, 15_000);
    void (async () => {
      try {
        await messageTasks.idle();
        await Promise.all([persistMessages, persistReads, persistPins, persistLiveMedia].map((p) => p.idle()));
        flushAllPersists();
        if (messageStore) await messageStore.close();
        clearTimeout(deadline);
        process.exit(0);
      } catch {
        console.error("[shutdown] failed to persist state");
        process.exit(1);
      }
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}).catch((error) => {
  console.error("[startup]", error.message);
  process.exit(1);
});
