import { hasLiveMediaSession } from "@/lib/mediaResume";

const BOOT_KEY = "pulse-boot-id";
const PENDING_KEY = "pulse-boot-pending";

function storedBootId() {
  try {
    return sessionStorage.getItem(BOOT_KEY) || "";
  } catch {
    return "";
  }
}

function writeBootId(bootId: string) {
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

function reloadNow(bootId: string) {
  writeBootId(bootId);
  clearPendingBootId();
  window.location.reload();
}

/** Reload after a deploy. During a live call wait — WebRTC stays up, then reload. */
export function applyBootId(bootId: string) {
  if (!bootId || typeof window === "undefined") return;
  const prev = storedBootId();
  if (!prev) {
    writeBootId(bootId);
    return;
  }
  if (prev === bootId) {
    clearPendingBootId();
    return;
  }
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
  if (pending === storedBootId()) {
    clearPendingBootId();
    return;
  }
  reloadNow(pending);
}

export function watchAppBoot(
  socket: {
    on: (event: "app:boot", fn: (payload: { bootId?: string }) => void) => void;
    off: (event: "app:boot", fn: (payload: { bootId?: string }) => void) => void;
  } | null,
) {
  const onBoot = (payload: { bootId?: string } | undefined) => {
    if (payload?.bootId) applyBootId(payload.bootId);
  };

  socket?.on("app:boot", onBoot);

  let cancelled = false;
  const poll = async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as { bootId?: string };
      if (data?.bootId) applyBootId(data.bootId);
    } catch {
      /* server is bouncing */
    }
  };

  void poll();
  const timer = window.setInterval(() => {
    void poll();
  }, 8_000);

  return () => {
    cancelled = true;
    window.clearInterval(timer);
    socket?.off("app:boot", onBoot);
  };
}
