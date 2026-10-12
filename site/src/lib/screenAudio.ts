"use client";

/** Громкость звука демонстраций экрана — отдельная ручка на каждую демонстрацию. */

const SCREEN_VOLUME_KEY = "pulse-screen-volume";

const DEFAULT_OWNER = "__default__";
let loaded = false;
const volumeByOwner = new Map<string, number>();
const elementsByOwner = new Map<string, Set<HTMLAudioElement>>();
const ownerByElement = new WeakMap<HTMLAudioElement, string>();
const listeners = new Set<() => void>();

/** Подписка на изменения громкости (чтобы все ручки одного владельца были в синхроне). */
export function subscribeScreenAudioVolume(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

function ownerKey(owner?: string | null) {
  return owner ? String(owner) : DEFAULT_OWNER;
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(SCREEN_VOLUME_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      // Старый формат — единая громкость для всех демонстраций.
      volumeByOwner.set(DEFAULT_OWNER, clamp(parsed));
      return;
    }
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (typeof value === "number" && Number.isFinite(value)) {
          volumeByOwner.set(key, clamp(value));
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function persist() {
  try {
    const map: Record<string, number> = {};
    for (const [key, value] of volumeByOwner) map[key] = value;
    localStorage.setItem(SCREEN_VOLUME_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function getScreenAudioVolume(owner?: string | null): number {
  load();
  return volumeByOwner.get(ownerKey(owner)) ?? 1;
}

export function setScreenAudioVolume(volume: number, owner?: string | null) {
  load();
  const key = ownerKey(owner);
  const next = clamp(volume);
  volumeByOwner.set(key, next);
  persist();
  const elements = elementsByOwner.get(key);
  if (elements) {
    for (const element of elements) element.volume = next;
  }
  for (const listener of listeners) listener();
}

/** Регистрирует аудиоэлемент звука демонстрации (сразу применяет громкость). */
export function registerScreenAudio(
  element: HTMLAudioElement,
  owner?: string | null,
) {
  load();
  const key = ownerKey(owner);
  const previous = ownerByElement.get(element);
  if (previous && previous !== key) {
    const old = elementsByOwner.get(previous);
    old?.delete(element);
    if (old && !old.size) elementsByOwner.delete(previous);
  }
  const set = elementsByOwner.get(key) ?? new Set<HTMLAudioElement>();
  set.add(element);
  elementsByOwner.set(key, set);
  ownerByElement.set(element, key);
  element.volume = volumeByOwner.get(key) ?? 1;
}

export function unregisterScreenAudio(element: HTMLAudioElement) {
  const key = ownerByElement.get(element);
  if (!key) return;
  ownerByElement.delete(element);
  // В звонке и mesh это тот же элемент, что играет голос собеседника.
  element.volume = 1;
  const set = elementsByOwner.get(key);
  if (set) {
    set.delete(element);
    if (!set.size) elementsByOwner.delete(key);
  }
}

// The desktop UI and persistent media owner share storage but have separate
// module instances. Apply UI volume changes to the owner's playing elements.
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== SCREEN_VOLUME_KEY) return;
  loaded = false;
  volumeByOwner.clear();
  load();
  for (const [owner, elements] of elementsByOwner) {
    for (const element of elements) element.volume = volumeByOwner.get(owner) ?? 1;
  }
  for (const listener of listeners) listener();
});
