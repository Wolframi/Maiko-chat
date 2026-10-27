import type { IncomingMessage, ServerResponse } from "node:http";
import type { SavedRingtone } from "../lib/ringtoneSettings";
import { getUserById, restoreSession, saveUserRingtoneSettings } from "./auth";
import { bareUploadUrl, getUploadInfo, signUploadUrl, uploadOwnedBy } from "./uploads";
import { rateLimit } from "./rateLimit";
import { ringtoneAudioPath } from "../lib/ringtoneConfig";

function signed(tone: SavedRingtone | null) {
  if (!tone) return tone;
  if (tone.id !== "custom") {
    const remote = new URL(tone.url, "http://localhost").searchParams.get("u");
    return remote ? { ...tone, url: ringtoneAudioPath(remote), startSec: 0 } : tone;
  }
  return { ...tone, url: signUploadUrl(tone.url),
    source: tone.source ? { ...tone.source, url: signUploadUrl(tone.source.url) } : undefined };
}

function snapshot(userId: string) {
  const settings = getUserById(userId)?.ringtoneSettings;
  return { initialized: settings !== undefined,
    ringtone: signed(settings?.ringtone || null), custom: signed(settings?.custom || null) };
}

async function audioUpload(raw: unknown, userId: string, source = false) {
  if (typeof raw !== "string" || !/^\/uploads\/[0-9a-f-]{36}\.(wav|mp3|m4a|aac|ogg|opus|flac|weba|webm)(?:\?|$)/i.test(raw)) {
    throw new Error("Некорректный аудиофайл");
  }
  const url = bareUploadUrl(raw);
  const info = await getUploadInfo(url);
  if (!uploadOwnedBy(url, userId) || !info || info.size <= 0 || info.size > 12 * 1024 * 1024 || !(info.mime.startsWith("audio/") || (source && info.mime === "video/webm"))) {
    throw new Error("Некорректный аудиофайл");
  }
  return url;
}

export async function handleRingtonePreference(req: IncomingMessage, res: ServerResponse,
  changed: (userId: string) => void, allowedUrl: (url: string) => boolean) {
  if ((req.url || "").split("?")[0] !== "/api/ringtones/preference") return false;
  const reply = (status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const token = String(req.headers["x-pulse-token"] || "");
  const auth = restoreSession(token);
  if (!auth.ok) { reply(401, { ok: false, error: "Сначала войдите в аккаунт" }); return true; }
  const userId = auth.account.userId;
  if (req.method === "GET") { reply(200, { ok: true, settings: snapshot(userId) }); return true; }
  if (req.method !== "PUT") { res.setHeader("Allow", "GET, PUT"); reply(405, { ok: false }); return true; }
  if (!rateLimit(`ringtone-preference:${userId}`, 40, 60_000)) { reply(429, { ok: false, error: "Слишком много изменений" }); return true; }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32 * 1024) { reply(413, { ok: false, error: "Запрос слишком большой" }); return true; }
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Некорректные настройки");
    if (body.ifAbsent === true && getUserById(userId)?.ringtoneSettings) {
      reply(200, { ok: true, settings: snapshot(userId) }); return true;
    }
    let tone: SavedRingtone | null = null;
    if (Object.hasOwn(body, "custom") && body.custom !== null) {
      const raw = body.custom;
      if (!raw || typeof raw.title !== "string" || !raw.title.trim()) throw new Error("Некорректный рингтон");
      const url = await audioUpload(raw.url, userId);
      tone = { id: "custom", title: raw.title.trim().slice(0, 120), url, startSec: 0 };
      if (raw.source) {
        const { name, startSec, endSec } = raw.source;
        if (typeof name !== "string" || !Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec || endSec - startSec > 45.1) {
          throw new Error("Некорректная обрезка рингтона");
        }
        tone.source = { url: await audioUpload(raw.source.url, userId, true), name: name.slice(0, 120), startSec, endSec };
      }
    } else if (!Object.hasOwn(body, "custom")) {
      if (!Object.hasOwn(body, "ringtone")) throw new Error("Некорректные настройки");
      const raw = body.ringtone;
      if (raw !== null && raw?.id !== "custom") {
        if (typeof raw?.id !== "string" || !raw.id || raw.id.length > 160 || typeof raw.title !== "string" || !raw.title.trim() || typeof raw.url !== "string") throw new Error("Некорректный рингтон");
        const proxy = new URL(raw.url, "http://localhost");
        const remote = proxy.searchParams.get("u") || "";
        const startSec = Number(raw.startSec || 0);
        if (!raw.url.startsWith("/api/ringtones/audio?") || !allowedUrl(remote) || !Number.isFinite(startSec) || startSec < 0 || startSec > 3600) throw new Error("Некорректный рингтон");
        tone = { id: raw.id, title: raw.title.trim().slice(0, 120), url: ringtoneAudioPath(remote), startSec: 0 };
      }
    }
    if (!restoreSession(token).ok) { reply(401, { ok: false }); return true; }
    const current = getUserById(userId)?.ringtoneSettings || { ringtone: null, custom: null };
    if (body.ifAbsent === true && getUserById(userId)?.ringtoneSettings) {
      reply(200, { ok: true, settings: snapshot(userId) }); return true;
    }
    let next;
    if (Object.hasOwn(body, "custom")) {
      next = { custom: tone, ringtone: tone || (current.ringtone?.id === "custom" ? null : current.ringtone) };
    } else {
      if (body.ringtone?.id === "custom") {
        if (!current.custom) throw new Error("Сначала загрузите свой рингтон");
        tone = current.custom;
      }
      next = { ...current, ringtone: tone };
    }
    try { saveUserRingtoneSettings(userId, next); }
    catch { reply(503, { ok: false, error: "Не удалось сохранить рингтон. Повторите попытку." }); return true; }
    changed(userId);
    reply(200, { ok: true, settings: snapshot(userId) });
  } catch (error) {
    reply(400, { ok: false, error: error instanceof Error ? error.message : "Не удалось сохранить рингтон" });
  }
  return true;
}
