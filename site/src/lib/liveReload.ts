import {
  canReloadLiveMedia,
  hasLiveMediaSession,
  markPageUnloading,
  persistLiveMediaNow,
} from "@/lib/mediaResume";
import { getDesktopMediaRuntime, isDesktopMediaOwner } from "@/lib/desktopMedia";

const BOOT_KEY = "pulse-boot-id";
const PENDING_KEY = "pulse-boot-pending";
const BOOT_QUERY = "_b";
const RELOAD_NOTICE_KEY = "pulse-site-reloaded";
const MANUAL_KEY = "pulse-site-update-manual";
export type SiteUpdateNotice = { version: string; busy: boolean; error?: string };
let updateNotice: SiteUpdateNotice | null = null;
const noticeListeners = new Set<() => void>();
export const getSiteUpdateNotice = () => updateNotice;
export function subscribeSiteUpdateNotice(listener: () => void) {
  noticeListeners.add(listener);
  return () => { noticeListeners.delete(listener); };
}
function publishNotice(next: SiteUpdateNotice | null) {
  if (JSON.stringify(next) === JSON.stringify(updateNotice)) return;
  updateNotice = next;
  for (const listener of noticeListeners) listener();
}
function manualUpdateRequired() {
  if (updateNotice) return true;
  try { return Boolean(sessionStorage.getItem(MANUAL_KEY)); } catch { return false; }
}
function requireManualUpdate(version: string) {
  writePendingBootId(version);
  try { sessionStorage.setItem(MANUAL_KEY, version); } catch { /* memory notice remains */ }
  publishNotice({ version, busy: false });
}
export function requestPendingSiteReload() {
  const version = pendingBootId();
  if (version) void reloadNow(version, true);
}

export function consumeSiteReloadNotice() {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_NOTICE_KEY));
    sessionStorage.removeItem(RELOAD_NOTICE_KEY);
    return at > 0 && Date.now() - at < 90_000;
  } catch { return false; }
}

/** In-memory copy so a blocked/empty sessionStorage cannot skip reloads forever. */
let memoryBootId = "";
let memoryPendingId = "";
let reloadInProgress = false;
let bootSocket: BootSocket | null = null;
let pollerBound = false;
let pollInFlight: AbortController | null = null;
let burstUntil = 0;
let burstTimer: number | null = null;

function storedBootId() {
  try {
    return sessionStorage.getItem(BOOT_KEY) || "";
  } catch {
    return "";
  }
}

function writeBootId(bootId: string) {
  memoryBootId = bootId;
  try {
    sessionStorage.setItem(BOOT_KEY, bootId);
  } catch {
    /* ignore */
  }
}

function pendingBootId() {
  if (memoryPendingId) return memoryPendingId;
  try {
    return sessionStorage.getItem(PENDING_KEY) || "";
  } catch {
    return "";
  }
}

function writePendingBootId(bootId: string) {
  memoryPendingId = bootId;
  try {
    sessionStorage.setItem(PENDING_KEY, bootId);
  } catch {
    /* ignore */
  }
}

function clearPendingBootId() {
  memoryPendingId = "";
  try {
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(MANUAL_KEY);
  } catch {
    /* ignore */
  }
  publishNotice(null);
}

function knownBootId() {
  // The loaded bundle is authoritative, including when a stale tab's first
  // health request arrives only AFTER a deployment. Storage alone is not.
  return process.env.NEXT_PUBLIC_SITE_VERSION || memoryBootId || storedBootId();
}

function stripBootQuery() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(BOOT_QUERY) && !url.searchParams.has("_t")) return;
  url.searchParams.delete(BOOT_QUERY);
  url.searchParams.delete("_t");
  const search = url.searchParams.toString();
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${search ? `?${search}` : ""}${url.hash}`,
  );
}

async function reloadNow(bootId: string, manual = false) {
  if (reloadInProgress) return;
  persistLiveMediaNow();
  const persistent = Boolean(getDesktopMediaRuntime());
  if (!persistent && !manual && manualUpdateRequired()) {
    requireManualUpdate(bootId);
    return;
  }
  if (!persistent && !manual && !canReloadLiveMedia()) {
    writePendingBootId(bootId);
    // Browsers cannot preserve display capture across document navigation.
    // Once notified, let the user decide even if sharing ends later.
    try {
      const saved = sessionStorage.getItem("pulse-media-resume");
      if (hasLiveMediaSession() && saved && JSON.parse(saved).sharingScreen) requireManualUpdate(bootId);
    } catch { /* no reliable snapshot: keep protecting the current session */ }
    return;
  }
  // Wait for authenticated signaling to rebind after the server restart.
  // The server reserves presence before the old document is destroyed.
  if (!persistent && hasLiveMediaSession() && !bootSocket?.connected) {
    writePendingBootId(bootId);
    return;
  }
  reloadInProgress = true;
  if (manual) publishNotice({ version: bootId, busy: true });
  let navigating = false;
  try {
    if (!persistent && hasLiveMediaSession()) {
      const socket = bootSocket;
      const prepared = await new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => resolve(false), 2500);
        socket?.emit?.("app:prepare-reload", { buildId: bootId }, (result) => {
          window.clearTimeout(timer);
          resolve(Boolean(result?.ok));
        });
      });
      if (!prepared) { writePendingBootId(bootId); return; }
    }
    // Verify readiness even for a socket notification: never navigate into
    // a restarting server, an unhealthy deployment or a different version.
    const response = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!response.ok) { writePendingBootId(bootId); return; }
    const health = await response.json() as BootNotice;
    if (versionOf(health) !== bootId) { writePendingBootId(versionOf(health) || bootId); return; }
    persistLiveMediaNow();
    if (!persistent && !manual && !canReloadLiveMedia()) { writePendingBootId(bootId); return; }
    if (persistent) getDesktopMediaRuntime()?.reportSiteUpdate("loading");
    markPageUnloading();
    writeBootId(bootId);
    clearPendingBootId();
    try { sessionStorage.setItem(RELOAD_NOTICE_KEY, String(Date.now())); } catch { /* optional UI notice */ }
    const url = new URL(window.location.href);
    url.searchParams.set(BOOT_QUERY, bootId);
    url.searchParams.set("_t", String(Date.now()));
    navigating = true;
    window.location.replace(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    writePendingBootId(bootId);
  } finally {
    if (!navigating) {
      reloadInProgress = false;
      if (manual) publishNotice({ version: pendingBootId() || bootId, busy: false, error: "Сервер пока недоступен. Попробуйте ещё раз." });
    }
  }
}

/** Reload a ready deployment and restore the existing media session. */
export function applyBootId(bootId: string) {
  if (!bootId || typeof window === "undefined") return;
  const prev = knownBootId();
  if (!prev) {
    writeBootId(bootId);
    return;
  }
  if (prev === bootId) {
    memoryBootId = bootId;
    clearPendingBootId();
    return;
  }
  void reloadNow(bootId);
}

/** Retry once ringing, screen sharing or a pending media join has ended. */
export function flushPendingBootReload() {
  if (typeof window === "undefined") return;
  const pending = pendingBootId();
  if (!pending) return;
  if (pending === knownBootId()) {
    clearPendingBootId();
    return;
  }
  void reloadNow(pending);
}

type BootNotice = { bootId?: string; buildId?: string };
function versionOf(notice: BootNotice) {
  const value = notice.buildId || notice.bootId || "";
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : "";
}

async function pollHealth() {
  if (pollInFlight) return;
  // Hidden tabs don't need the reload-deploy ping every 1.5s.
  if (typeof document !== "undefined" && document.hidden) return;
  const ac = new AbortController();
  pollInFlight = ac;
  const timeout = window.setTimeout(() => ac.abort(), 2500);
  try {
    const res = await fetch("/api/health", {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      signal: ac.signal,
    });
    if (!res.ok) return;
    const data = (await res.json()) as BootNotice;
    const version = versionOf(data);
    if (version) applyBootId(version);
    flushPendingBootReload();
  } catch {
    /* server is bouncing — burst poll will retry */
  } finally {
    window.clearTimeout(timeout);
    if (pollInFlight === ac) pollInFlight = null;
  }
}

function startBurstPoll() {
  burstUntil = Date.now() + 45_000;
  if (burstTimer != null) return;
  const tick = () => {
    void pollHealth();
    if (Date.now() < burstUntil) {
      burstTimer = window.setTimeout(tick, 400);
    } else {
      burstTimer = null;
    }
  };
  tick();
}

function onVisible() {
  if (typeof document !== "undefined" && document.hidden) return;
  startBurstPoll();
}

function ensurePoller() {
  if (pollerBound || typeof window === "undefined") return;
  pollerBound = true;
  stripBootQuery();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);
  window.addEventListener("focus", onVisible);
  window.addEventListener("pageshow", onVisible);
  void pollHealth();
  window.setInterval(() => {
    void pollHealth();
  }, 1_500);
}

type BootSocket = {
  connected?: boolean;
  emit?: (event: "app:prepare-reload", payload: { buildId: string }, ack: (result?: { ok?: boolean }) => void) => void;
  on: (
    event: "app:boot" | "connect" | "disconnect",
    fn: (payload?: BootNotice) => void,
  ) => void;
  off: (
    event: "app:boot" | "connect" | "disconnect",
    fn: (payload?: BootNotice) => void,
  ) => void;
};

export function watchAppBoot(socket: BootSocket | null) {
  // The media owner survives deployments; only its child UI checks versions.
  if (isDesktopMediaOwner()) return () => {};
  ensurePoller();
  if (socket) bootSocket = socket;

  const onBoot = (payload: BootNotice | undefined) => {
    const version = payload && versionOf(payload);
    if (version) applyBootId(version);
  };
  const onConnect = () => {
    void pollHealth();
  };
  const onDisconnect = () => {
    startBurstPoll();
  };

  socket?.on("app:boot", onBoot);
  socket?.on("connect", onConnect);
  socket?.on("disconnect", onDisconnect);

  return () => {
    if (socket && bootSocket === socket) bootSocket = null;
    socket?.off("app:boot", onBoot);
    socket?.off("connect", onConnect);
    socket?.off("disconnect", onDisconnect);
  };
}
