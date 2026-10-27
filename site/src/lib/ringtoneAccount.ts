import type { RingtoneSettings } from "./ringtoneSettings";

let account: { userId: string; token: string } | null = null;
let settings: RingtoneSettings | null = null;
let requestSequence = 0;
let appliedSequence = 0;

export const getRingtoneAccount = () => account;
export const getAccountRingtoneSettings = () => settings;

export function configureRingtoneAccount(next: typeof account) {
  if (account?.userId === next?.userId && account?.token === next?.token) return;
  const changed = account?.userId !== next?.userId;
  account = next;
  if (changed) settings = null;
}

export async function requestRingtoneSettings(patch?: Record<string, unknown>) {
  const current = account;
  if (!current) throw new Error("Сначала войдите в аккаунт");
  const sequence = ++requestSequence;
  const response = await fetch("/api/ringtones/preference", {
    method: patch ? "PUT" : "GET",
    headers: { "x-pulse-token": current.token, ...(patch ? { "Content-Type": "application/json" } : {}) },
    body: patch ? JSON.stringify(patch) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || "Не удалось сохранить рингтон");
  if (account !== current) throw new Error("Аккаунт изменился");
  if (sequence < appliedSequence) return settings!;
  appliedSequence = sequence;
  settings = body.settings as RingtoneSettings;
  window.dispatchEvent(new CustomEvent("pulse:ringtone-settings", { detail: settings }));
  return settings;
}
