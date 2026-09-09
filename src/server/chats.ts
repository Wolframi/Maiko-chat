import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  dmChatId,
  normalizeRoomId,
} from "../lib/rooms";
import type { ChatType, GroupVisibility } from "../lib/types";
import { getDisplayNameById, getUserById, listUsers } from "./auth";

const PROTECTED_CHAT_IDS = new Set<string>();

export type VoiceChannelMeta = {
  id: string;
  title: string;
  createdAt: number;
};

export type ChatMeta = {
  id: string;
  type: ChatType;
  title: string;
  topic: string;
  memberIds: string[];
  createdAt: number;
  createdBy?: string;
  /** Empty DMs are listed only for members who explicitly opened them. */
  visibleTo?: string[];
  avatarUrl?: string;
  /** Groups only. Legacy chats without the field are private. */
  visibility?: GroupVisibility;
  voiceChannels?: VoiceChannelMeta[];
};

export function groupVisibility(chat: ChatMeta): GroupVisibility {
  if (chat.type !== "group") return "private";
  return chat.visibility === "public" ? "public" : "private";
}

function normalizeVisibility(value: unknown): GroupVisibility {
  return value === "private" ? "private" : "public";
}

const DATA_DIR = path.join(process.cwd(), "data");
const CHATS_FILE = path.join(DATA_DIR, "chats.json");

const chats = new Map<string, ChatMeta>();

let chatsDirty = false;
let chatsChain: Promise<void> = Promise.resolve();

function writeChatsSnapshot() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  const payload = JSON.stringify([...chats.values()], null, 2);
  const tmp = `${CHATS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, payload, "utf8");
  try {
    renameSync(tmp, CHATS_FILE);
  } catch {
    // Windows may lock the target briefly — fall back to direct write.
    writeFileSync(CHATS_FILE, payload, "utf8");
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function saveChats() {
  chatsDirty = true;
  chatsChain = chatsChain.then(async () => {
    while (chatsDirty) {
      chatsDirty = false;
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          try {
            writeChatsSnapshot();
          } catch (error) {
            console.error("[persist:chats]", error);
          }
          resolve();
        });
      });
    }
  });
}

function loadChats() {
  if (existsSync(CHATS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(CHATS_FILE, "utf8")) as ChatMeta[];
      for (const chat of raw) {
        // Drop legacy global lobby/random channels from older installs.
        if (chat.type === "channel") continue;
        ensureVoiceChannels(chat);
        chats.set(chat.id, chat);
      }
    } catch {
      /* ignore */
    }
  }

  saveChats();
}

loadChats();

export function getChat(id: string) {
  return chats.get(id) ?? null;
}

export function canAccessChat(chat: ChatMeta, userId: string) {
  if (chat.type === "channel") return true;
  return chat.memberIds.includes(userId);
}

export function listChatsForUser(userId: string) {
  return [...chats.values()].filter(
    (chat) => chat.type !== "channel" && canAccessChat(chat, userId),
  );
}

export function peerIdForViewer(chat: ChatMeta, viewerId: string) {
  if (chat.type !== "dm") return undefined;
  return chat.memberIds.find((id) => id !== viewerId);
}

export function openDm(userIdA: string, userIdB: string) {
  if (userIdA === userIdB) {
    return { ok: false as const, error: "Нельзя написать самому себе" };
  }

  const id = dmChatId(userIdA, userIdB);
  const existing = chats.get(id);
  if (existing) {
    if (existing.visibleTo && !existing.visibleTo.includes(userIdA)) {
      existing.visibleTo = [...existing.visibleTo, userIdA];
      saveChats();
    }
    return { ok: true as const, chat: existing };
  }

  const otherName = getDisplayNameById(userIdB);
  const chat: ChatMeta = {
    id,
    type: "dm",
    title: otherName,
    topic: "Личные сообщения",
    memberIds: [userIdA, userIdB].sort(),
    createdAt: Date.now(),
    createdBy: userIdA,
    visibleTo: [userIdA],
  };
  chats.set(id, chat);
  saveChats();
  return { ok: true as const, chat };
}

export function createGroup(
  ownerId: string,
  titleRaw: string,
  topicRaw: string,
  _memberIdsRaw: string[] = [],
  visibilityRaw: GroupVisibility | string = "public",
) {
  const title = titleRaw.trim().slice(0, 40);
  if (!title) return { ok: false as const, error: "Укажите название группы" };

  const topic = topicRaw.trim().slice(0, 120) || "Групповой чат";
  const visibility = normalizeVisibility(visibilityRaw);

  let id = `group_${normalizeRoomId(title)}`;
  if (chats.has(id)) {
    id = `group_${normalizeRoomId(title)}_${randomUUID().slice(0, 6)}`;
  }

  const chat: ChatMeta = {
    id,
    type: "group",
    title,
    topic,
    memberIds: [ownerId],
    createdAt: Date.now(),
    createdBy: ownerId,
    visibility,
    voiceChannels: [
      {
        id: `${id}::voice_general`,
        title: "Общий",
        createdAt: Date.now(),
      },
    ],
  };
  chats.set(id, chat);
  saveChats();
  return { ok: true as const, chat };
}

export function searchPublicGroups(viewerId: string, queryRaw: string) {
  const query = queryRaw.trim().toLowerCase();
  const hits: Array<{
    id: string;
    title: string;
    topic: string;
    members: number;
    avatarUrl?: string;
    joined: boolean;
    createdAt: number;
  }> = [];

  for (const chat of chats.values()) {
    if (chat.type !== "group" || groupVisibility(chat) !== "public") continue;
    if (
      query &&
      !chat.title.toLowerCase().includes(query) &&
      !chat.topic.toLowerCase().includes(query)
    ) {
      continue;
    }
    hits.push({
      id: chat.id,
      title: chat.title,
      topic: chat.topic,
      members: chat.memberIds.length,
      avatarUrl: chat.avatarUrl,
      joined: chat.memberIds.includes(viewerId),
      createdAt: chat.createdAt,
    });
  }

  hits.sort((a, b) => {
    if (a.joined !== b.joined) return a.joined ? 1 : -1;
    if (b.members !== a.members) return b.members - a.members;
    return b.createdAt - a.createdAt;
  });

  return hits.slice(0, 30).map(({ createdAt: _createdAt, ...rest }) => rest);
}

export function joinPublicGroup(userId: string, groupId: string) {
  const chat = chats.get(groupId);
  // Opaque error: do not reveal whether a private group id exists.
  if (!chat || chat.type !== "group" || groupVisibility(chat) !== "public") {
    return { ok: false as const, error: "Группа не найдена" };
  }
  return addGroupMember(groupId, userId);
}

export function updateGroupVisibility(
  chatId: string,
  userId: string,
  visibilityRaw: GroupVisibility | string,
) {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false as const, error: "Чат не найден" };
  if (chat.type !== "group") {
    return { ok: false as const, error: "Это не группа" };
  }
  if (isProtectedChat(chat)) {
    return { ok: false as const, error: "Системную группу нельзя изменить" };
  }
  if (!chat.createdBy || chat.createdBy !== userId) {
    return {
      ok: false as const,
      error: "Только создатель группы может менять доступ",
    };
  }
  chat.visibility = normalizeVisibility(visibilityRaw);
  chats.set(chatId, chat);
  saveChats();
  return { ok: true as const, chat };
}

export function addGroupMember(groupId: string, userId: string) {
  const chat = chats.get(groupId);
  if (!chat || chat.type !== "group") {
    return { ok: false as const, error: "Группа не найдена" };
  }
  if (!getUserById(userId)) {
    return { ok: false as const, error: "Пользователь не найден" };
  }
  if (chat.memberIds.includes(userId)) {
    return { ok: true as const, chat, already: true as const };
  }
  if (chat.memberIds.length >= 50) {
    return { ok: false as const, error: "В группе не больше 50 участников" };
  }
  chat.memberIds = [...chat.memberIds, userId];
  chats.set(chat.id, chat);
  saveChats();
  return { ok: true as const, chat, already: false as const };
}

export function ensureVoiceChannels(chat: ChatMeta): ChatMeta {
  if (chat.type !== "group") return chat;
  if (chat.voiceChannels && chat.voiceChannels.length > 0) return chat;
  chat.voiceChannels = [
    {
      id: `${chat.id}::voice_general`,
      title: "Общий",
      createdAt: chat.createdAt,
    },
  ];
  chats.set(chat.id, chat);
  saveChats();
  return chat;
}

export function findVoiceChannel(channelId: string): {
  group: ChatMeta;
  channel: VoiceChannelMeta;
} | null {
  for (const chat of chats.values()) {
    if (chat.type !== "group") continue;
    ensureVoiceChannels(chat);
    const channel = chat.voiceChannels?.find((item) => item.id === channelId);
    if (channel) return { group: chat, channel };
  }
  return null;
}

export function createVoiceChannel(
  groupId: string,
  userId: string,
  titleRaw: string,
) {
  const chat = chats.get(groupId);
  if (!chat || chat.type !== "group") {
    return { ok: false as const, error: "Группа не найдена" };
  }
  if (!canAccessChat(chat, userId)) {
    return { ok: false as const, error: "Нет доступа" };
  }
  ensureVoiceChannels(chat);
  const title = titleRaw.trim().slice(0, 40) || "Голосовой";
  if ((chat.voiceChannels?.length || 0) >= 20) {
    return { ok: false as const, error: "Слишком много голосовых каналов" };
  }
  const channel: VoiceChannelMeta = {
    id: `${chat.id}::voice_${normalizeRoomId(title)}_${randomUUID().slice(0, 5)}`,
    title,
    createdAt: Date.now(),
  };
  chat.voiceChannels = [...(chat.voiceChannels || []), channel];
  chats.set(chat.id, chat);
  saveChats();
  return { ok: true as const, chat, channel };
}

export function deleteVoiceChannel(
  groupId: string,
  channelId: string,
  userId: string,
) {
  const chat = chats.get(groupId);
  if (!chat || chat.type !== "group") {
    return { ok: false as const, error: "Группа не найдена" };
  }
  if (!chat.createdBy || chat.createdBy !== userId) {
    return {
      ok: false as const,
      error: "Только создатель группы может удалять каналы",
    };
  }
  ensureVoiceChannels(chat);
  const list = chat.voiceChannels || [];
  if (!list.some((channel) => channel.id === channelId)) {
    return { ok: false as const, error: "Канал не найден" };
  }
  if (channelId.endsWith("::voice_general")) {
    return { ok: false as const, error: "Общий канал нельзя удалить" };
  }
  if (list.length <= 1) {
    return { ok: false as const, error: "Нельзя удалить последний голосовой канал" };
  }
  chat.voiceChannels = list.filter((channel) => channel.id !== channelId);
  chats.set(chat.id, chat);
  saveChats();
  return { ok: true as const, chat };
}

export function updateGroupAvatar(
  chatId: string,
  userId: string,
  avatarUrl: string | null,
) {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false as const, error: "Чат не найден" };
  if (chat.type !== "group" && chat.type !== "channel") {
    return { ok: false as const, error: "Аватар можно менять только у группы" };
  }
  if (!chat.createdBy || chat.createdBy !== userId) {
    return {
      ok: false as const,
      error: "Только создатель группы может менять аватар",
    };
  }

  if (avatarUrl === null || avatarUrl === "") {
    delete chat.avatarUrl;
  } else {
    chat.avatarUrl = avatarUrl;
  }
  chats.set(chatId, chat);
  saveChats();
  return { ok: true as const, chat };
}

export function updateGroupProfile(
  chatId: string,
  userId: string,
  patch: { title?: string; topic?: string },
) {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false as const, error: "Чат не найден" };
  if (chat.type !== "group") {
    return { ok: false as const, error: "Название можно менять только у группы" };
  }
  if (isProtectedChat(chat)) {
    return { ok: false as const, error: "Системную группу нельзя переименовать" };
  }
  if (!chat.createdBy || chat.createdBy !== userId) {
    return {
      ok: false as const,
      error: "Только создатель группы может менять название",
    };
  }

  if (typeof patch.title === "string") {
    const title = patch.title.trim().slice(0, 40);
    if (!title) return { ok: false as const, error: "Укажите название группы" };
    chat.title = title;
  }
  if (typeof patch.topic === "string") {
    chat.topic = patch.topic.trim().slice(0, 120);
  }
  chats.set(chatId, chat);
  saveChats();
  return { ok: true as const, chat };
}

export function isProtectedChat(chat: ChatMeta) {
  return chat.type === "channel" || PROTECTED_CHAT_IDS.has(chat.id);
}

export function deleteGroup(chatId: string, userId: string) {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false as const, error: "Чат не найден" };
  if (chat.type !== "group" || isProtectedChat(chat)) {
    return {
      ok: false as const,
      error: "Системные каналы и этот чат удалить нельзя",
    };
  }
  if (!chat.createdBy || chat.createdBy !== userId) {
    return {
      ok: false as const,
      error: "Только создатель может удалить группу",
    };
  }

  chats.delete(chatId);
  saveChats();
  return { ok: true as const, chat };
}

export function leaveGroup(chatId: string, userId: string) {
  const chat = chats.get(chatId);
  if (!chat) return { ok: false as const, error: "Чат не найден" };
  if (chat.type !== "group" || isProtectedChat(chat)) {
    return {
      ok: false as const,
      error: "Системные каналы и этот чат покинуть нельзя",
    };
  }
  if (!chat.memberIds.includes(userId)) {
    return { ok: false as const, error: "Вы не участник этой группы" };
  }
  if (chat.createdBy === userId) {
    return {
      ok: false as const,
      error: "Создатель не может выйти — удалите группу",
    };
  }

  chat.memberIds = chat.memberIds.filter((id) => id !== userId);
  chats.set(chatId, chat);
  saveChats();
  return { ok: true as const, chat };
}

export function dmTitleForViewer(chat: ChatMeta, viewerId: string) {
  if (chat.type !== "dm") return chat.title;
  const otherId = chat.memberIds.find((id) => id !== viewerId);
  return otherId ? getDisplayNameById(otherId) : chat.title;
}

export function allChatIds() {
  return [...chats.keys()];
}

/** Members for mentions / info. Channels → directory users. */
/** Members for mentions / guild roster. Channels → directory users. */
export function listMemberProfiles(
  chatId: string,
  viewerId: string,
  onlineIds: Set<string> = new Set(),
) {
  const chat = chats.get(chatId);
  if (!chat || !canAccessChat(chat, viewerId)) return [];

  let ids: string[] = [];
  if (chat.type === "channel") {
    ids = listUsers()
      .map((user) => user.id)
      .slice(0, 40);
  } else {
    ids = [...chat.memberIds];
  }

  const result: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
    bio: string;
    online: boolean;
    lastSeenAt?: number;
  }[] = [];

  for (const id of ids) {
    const user = getUserById(id);
    if (!user) continue;
    result.push({
      id: user.id,
      username: user.username,
      displayName: getDisplayNameById(user.id),
      avatarUrl: user.avatarUrl,
      bio: user.bio || "",
      online: onlineIds.has(user.id),
      lastSeenAt: user.lastSeenAt,
    });
  }

  result.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, "ru");
  });
  return result;
}
