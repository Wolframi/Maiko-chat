import {
  hasLiveMediaSession,
  markPageUnloading,
  persistLiveMediaNow,
} from "@/lib/mediaResume";

const BOOT_KEY = "pulse-boot-id";
const PENDING_KEY = "pulse-boot-pending";
const BOOT_QUERY = "_b";

/** In-memory copy so a blocked/empty sessionStorage cannot skip reloads forever. */
let memoryBootId = "";
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
  try {
    return sessionStorage.getItem(PENDING_KEY) || "";
  } catch {
    return "";
  }
}

function writePendingBootId(bootId: string) {
  try {
    sessionStorage.setItem(PENDING_KEY, bootId);
  } catch {
    /* ignore */
  }
}

function clearPendingBootId() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

function knownBootId() {
  return memoryBootId || storedBootId();
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

function reloadNow(bootId: string) {
  // Never reload while a call/voice session is live — WebRTC must survive
  // a deploy. flushPendingBootReload() runs once the session ends.
  if (hasLiveMediaSession()) {
    writePendingBootId(bootId);
    return;
  }
  persistLiveMediaNow();
  markPageUnloading();
  writeBootId(bootId);
  clearPendingBootId();
  const url = new URL(window.location.href);
  url.searchParams.set(
    BOOT_QUERY,
    bootId.replace(/[^a-zA-Z0-9-]/g, "").slice(-12),
  );
  url.searchParams.set("_t", String(Date.now()));
  window.location.replace(`${url.pathname}${url.search}${url.hash}`);
}

/** Reload after a deploy. During a live call wait — WebRTC stays up, then reload. */
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
  // Defer the reload while a call/voice session is live.
  if (hasLiveMediaSession()) {
    writePendingBootId(bootId);
    return;
  }
  reloadNow(bootId);
}

/** Call when a call/voice session ends so a postponed deploy reload can run. */
export function flushPendingBootReload() {
  if (typeof window === "undefined") return;
  if (hasLiveMediaSession()) return;
  const pending = pendingBootId();
  if (!pending) return;
  if (pending === knownBootId()) {
    clearPendingBootId();
    return;
  }
  reloadNow(pending);
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
    const data = (await res.json()) as { bootId?: string };
    if (data?.bootId) applyBootId(data.bootId);
    if (!hasLiveMediaSession()) flushPendingBootReload();
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
  on: (
    event: "app:boot" | "connect" | "disconnect",
    fn: (payload?: { bootId?: string }) => void,
  ) => void;
  off: (
    event: "app:boot" | "connect" | "disconnect",
    fn: (payload?: { bootId?: string }) => void,
  ) => void;
};

export function watchAppBoot(socket: BootSocket | null) {
  ensurePoller();

  const onBoot = (payload: { bootId?: string } | undefined) => {
    if (payload?.bootId) applyBootId(payload.bootId);
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
    socket?.off("app:boot", onBoot);
    socket?.off("connect", onConnect);
    socket?.off("disconnect", onDisconnect);
  };
}
