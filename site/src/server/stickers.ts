import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getUserById } from "./auth";
import { bareUploadUrl, signUploadUrl } from "./uploads";

export const MAX_PACK_TITLE = 40;
export const MAX_STICKERS_PER_PACK = 60;
export const MAX_PACKS_PER_USER = 60;
export const MAX_STICKER_BYTES = 6 * 1024 * 1024;

export type StickerRecord = {
  id: string;
  url: string;
  name?: string;
  emoji?: string;
  animated?: boolean;
  width?: number;
  height?: number;
  size: number;
  addedAt: number;
};

export type StickerPackRecord = {
  id: string;
  title: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  stickers: StickerRecord[];
};

export type PublicSticker = StickerRecord;

export type PublicStickerPack = {
  id: string;
  title: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  stickers: PublicSticker[];
  stickerCount: number;
  coverUrl?: string;
  installed: boolean;
  canEdit: boolean;
  ownerName?: string;
};

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "stickers.json");

const packs = new Map<string, StickerPackRecord>();
const installs = new Map<string, Set<string>>();

let dirty = false;
let chain: Promise<void> = Promise.resolve();

function writeSnapshot() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify({
    packs: [...packs.values()],
    installs: Object.fromEntries(
      [...installs.entries()].map(([userId, set]) => [userId, [...set]]),
    ),
  });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, payload, "utf8");
  try {
    renameSync(tmp, FILE);
  } catch {
    writeFileSync(FILE, payload, "utf8");
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function save() {
  dirty = true;
  chain = chain.then(async () => {
    while (dirty) {
      dirty = false;
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          try {
            writeSnapshot();
          } catch (error) {
            console.error("[persist:stickers]", error);
          }
          resolve();
        });
      });
    }
  });
}

function load() {
  if (!existsSync(FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as {
      packs?: StickerPackRecord[];
      installs?: Record<string, string[]>;
    };
    for (const pack of raw.packs || []) {
      if (!pack?.id || !pack.createdBy) continue;
      packs.set(pack.id, {
        id: pack.id,
        title: String(pack.title || "Пак").slice(0, MAX_PACK_TITLE),
        createdBy: pack.createdBy,
        createdAt: Number(pack.createdAt) || Date.now(),
        updatedAt: Number(pack.updatedAt) || Date.now(),
        stickers: Array.isArray(pack.stickers)
          ? pack.stickers
              .filter((s) => s?.id && s?.url)
              .map((s) => ({
                id: s.id,
                url: bareUploadUrl(s.url),
                name: s.name,
                emoji: s.emoji,
                animated: Boolean(s.animated),
                width: Number(s.width) || undefined,
                height: Number(s.height) || undefined,
                size: Number(s.size) || 0,
                addedAt: Number(s.addedAt) || Date.now(),
              }))
          : [],
      });
    }
    for (const [userId, ids] of Object.entries(raw.installs || {})) {
      if (!userId || !Array.isArray(ids)) continue;
      installs.set(
        userId,
        new Set(ids.filter((id) => typeof id === "string" && packs.has(id))),
      );
    }
  } catch {
    /* ignore */
  }
}

load();

function publicSticker(record: StickerRecord): PublicSticker {
  return { ...record, url: signUploadUrl(bareUploadUrl(record.url)) };
}

export function packForViewer(
  pack: StickerPackRecord,
  viewerId: string,
): PublicStickerPack {
  const owner = getUserById(pack.createdBy);
  const installed =
    pack.createdBy === viewerId ||
    (installs.get(viewerId)?.has(pack.id) ?? false);
  return {
    id: pack.id,
    title: pack.title,
    createdBy: pack.createdBy,
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
    stickers: pack.stickers.map(publicSticker),
    stickerCount: pack.stickers.length,
    coverUrl: pack.stickers[0]
      ? signUploadUrl(bareUploadUrl(pack.stickers[0].url))
      : undefined,
    installed,
    canEdit: pack.createdBy === viewerId,
    ownerName: owner ? owner.displayName || owner.username : undefined,
  };
}

export function listPacksForUser(viewerId: string): PublicStickerPack[] {
  const out: PublicStickerPack[] = [];
  for (const pack of packs.values()) {
    if (
      pack.createdBy !== viewerId &&
      !installs.get(viewerId)?.has(pack.id)
    ) {
      continue;
    }
    out.push(packForViewer(pack, viewerId));
  }
  out.sort((a, b) => {
    if (a.canEdit !== b.canEdit) return a.canEdit ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  return out;
}

export function getPack(
  packId: string,
  viewerId: string,
): PublicStickerPack | null {
  const pack = packs.get(packId);
  if (!pack) return null;
  return packForViewer(pack, viewerId);
}

function countPacksOwnedBy(userId: string) {
  let n = 0;
  for (const pack of packs.values()) if (pack.createdBy === userId) n += 1;
  return n;
}

export function createPack(
  userId: string,
  titleRaw: string,
):
  | { ok: true; pack: PublicStickerPack }
  | { ok: false; error: string } {
  const title = titleRaw.trim().replace(/\s+/g, " ").slice(0, MAX_PACK_TITLE);
  if (!title) return { ok: false, error: "Укажите название пака" };
  if (countPacksOwnedBy(userId) >= MAX_PACKS_PER_USER) {
    return { ok: false, error: "Слишком много паков" };
  }
  const pack: StickerPackRecord = {
    id: `pack_${randomUUID().slice(0, 12)}`,
    title,
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stickers: [],
  };
  packs.set(pack.id, pack);
  save();
  return { ok: true, pack: packForViewer(pack, userId) };
}

export function updatePackTitle(
  packId: string,
  userId: string,
  titleRaw: string,
) {
  const pack = packs.get(packId);
  if (!pack) return { ok: false as const, error: "Пак не найден" };
  if (pack.createdBy !== userId) {
    return { ok: false as const, error: "Это не ваш пак" };
  }
  const title = titleRaw.trim().replace(/\s+/g, " ").slice(0, MAX_PACK_TITLE);
  if (!title) return { ok: false as const, error: "Укажите название пака" };
  pack.title = title;
  pack.updatedAt = Date.now();
  save();
  return { ok: true as const, pack: packForViewer(pack, userId) };
}

export function deletePack(packId: string, userId: string) {
  const pack = packs.get(packId);
  if (!pack) return { ok: false as const, error: "Пак не найден" };
  if (pack.createdBy !== userId) {
    return { ok: false as const, error: "Это не ваш пак" };
  }
  packs.delete(packId);
  for (const set of installs.values()) set.delete(packId);
  save();
  return { ok: true as const };
}

export function addSticker(
  packId: string,
  userId: string,
  input: {
    url: string;
    name?: string;
    emoji?: string;
    animated?: boolean;
    width?: number;
    height?: number;
    size: number;
  },
):
  | { ok: true; sticker: PublicSticker }
  | { ok: false; error: string } {
  const pack = packs.get(packId);
  if (!pack) return { ok: false, error: "Пак не найден" };
  if (pack.createdBy !== userId) {
    return { ok: false, error: "Это не ваш пак" };
  }
  if (pack.stickers.length >= MAX_STICKERS_PER_PACK) {
    return { ok: false, error: `Максимум ${MAX_STICKERS_PER_PACK} стикеров` };
  }
  const url = bareUploadUrl(input.url);
  if (!url.startsWith("/uploads/")) {
    return { ok: false, error: "Некорректный стикер" };
  }
  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > MAX_STICKER_BYTES) {
    return { ok: false, error: "Стикер больше 6 МБ" };
  }
  const sticker: StickerRecord = {
    id: `st_${randomUUID().slice(0, 10)}`,
    url,
    name: String(input.name || "").slice(0, 60) || undefined,
    emoji: String(input.emoji || "").slice(0, 8) || undefined,
    animated: Boolean(input.animated),
    width: Number.isFinite(input.width) ? Math.round(Number(input.width)) : undefined,
    height: Number.isFinite(input.height) ? Math.round(Number(input.height)) : undefined,
    size: Math.round(input.size),
    addedAt: Date.now(),
  };
  pack.stickers.push(sticker);
  pack.updatedAt = Date.now();
  save();
  return { ok: true, sticker: publicSticker(sticker) };
}

export function removeSticker(packId: string, userId: string, stickerId: string) {
  const pack = packs.get(packId);
  if (!pack) return { ok: false as const, error: "Пак не найден" };
  if (pack.createdBy !== userId) {
    return { ok: false as const, error: "Это не ваш пак" };
  }
  const before = pack.stickers.length;
  pack.stickers = pack.stickers.filter((s) => s.id !== stickerId);
  if (pack.stickers.length === before) {
    return { ok: false as const, error: "Стикер не найден" };
  }
  pack.updatedAt = Date.now();
  save();
  return { ok: true as const };
}

export function installPack(
  userId: string,
  packId: string,
): { ok: true; already: boolean } | { ok: false; error: string } {
  const pack = packs.get(packId);
  if (!pack) return { ok: false, error: "Пак не найден" };
  if (pack.createdBy === userId) return { ok: true, already: true };
  let set = installs.get(userId);
  if (!set) {
    set = new Set();
    installs.set(userId, set);
  }
  if (set.has(packId)) return { ok: true, already: true };
  set.add(packId);
  save();
  return { ok: true, already: false };
}

export function uninstallPack(userId: string, packId: string) {
  const set = installs.get(userId);
  if (!set || !set.has(packId)) {
    return { ok: true as const, already: true as const };
  }
  set.delete(packId);
  save();
  return { ok: true as const };
}

export function canSendSticker(userId: string, packId: string) {
  const pack = packs.get(packId);
  if (!pack) return false;
  if (pack.createdBy === userId) return true;
  return installs.get(userId)?.has(packId) ?? false;
}

export function findSticker(packId: string, stickerId: string) {
  const pack = packs.get(packId);
  if (!pack) return null;
  const sticker = pack.stickers.find((s) => s.id === stickerId);
  if (!sticker) return null;
  return { pack, sticker };
}