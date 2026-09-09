let audioCtx: AudioContext | null = null;
const SOUND_KEY = "pulse-sound-enabled";
let swRegisterPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function ensureAudio() {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

export function getSoundEnabled() {
  if (typeof window === "undefined") return true;
  try {
    const value = localStorage.getItem(SOUND_KEY);
    if (value === null) return true;
    return value === "1";
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SOUND_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function playMessageBeep() {
  if (!getSoundEnabled()) return;
  const ctx = ensureAudio();
  if (!ctx) return;

  void ctx.resume().then(() => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 740;
    gain.gain.value = 0.028;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.stop(ctx.currentTime + 0.24);
  });
}

export type NotifyPermission = NotificationPermission | "unsupported";

function isIosSafari() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/i.test(ua);
  const criOS = /CriOS/i.test(ua);
  const fxIOS = /FxiOS/i.test(ua);
  return iOS && webkit && !criOS && !fxIOS;
}

function isStandalonePwa() {
  if (typeof window === "undefined") return false;
  const mq = window.matchMedia?.("(display-mode: standalone)")?.matches;
  const iosStandalone = Boolean(
    (navigator as Navigator & { standalone?: boolean }).standalone,
  );
  return Boolean(mq || iosStandalone);
}

/** Why browser notifications may be limited on this device. */
export function getNotifyCapabilityHint(): string | null {
  if (typeof window === "undefined") return null;
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    if (isIosSafari() && !isStandalonePwa()) {
      return "На iPhone: Поделиться → На экран «Домой», откройте Pulse как приложение и разрешите уведомления.";
    }
    return "Этот браузер не поддерживает push-уведомления.";
  }
  if (isIosSafari() && !isStandalonePwa()) {
    return "На iPhone: добавьте сайт на экран «Домой», иначе звонки в свёрнутом Safari не доходят.";
  }
  if (!("PushManager" in window)) {
    return "Push недоступен в этом браузере.";
  }
  return "После «Разрешить» звонки и сообщения приходят даже в свёрнутом браузере.";
}

export function getNotifyPermission(): NotifyPermission {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

async function ensureNotifyServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  if (!swRegisterPromise) {
    swRegisterPromise = navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => reg)
      .catch(() => null);
  }
  return swRegisterPromise;
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Subscribe device for Web Push (calls/messages when tab is frozen). */
export async function subscribeWebPush(token: string) {
  if (!token || typeof window === "undefined") return false;
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return false;
  if (!("PushManager" in window)) return false;
  if (Notification.permission !== "granted") return false;

  try {
    const reg = await ensureNotifyServiceWorker();
    if (!reg) return false;
    await navigator.serviceWorker.ready;

    const vapidRes = await fetch("/api/push/vapid", { cache: "no-store" });
    const vapid = (await vapidRes.json()) as { ok?: boolean; publicKey?: string };
    if (!vapid?.ok || !vapid.publicKey) return false;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
      });
    }

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pulse-token": token,
      },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureNotifyPermission() {
  const current = getNotifyPermission();
  if (current === "unsupported") return current;
  if (current !== "default") {
    if (current === "granted") void ensureNotifyServiceWorker();
    return current;
  }
  try {
    const next = await Notification.requestPermission();
    if (next === "granted") void ensureNotifyServiceWorker();
    return next;
  } catch {
    return "denied" as NotifyPermission;
  }
}

export function showDesktopNotify(
  title: string,
  body: string,
  options?: {
    chatId?: string;
    tag?: string;
    /** false = allow OS sound (useful for calls) */
    silent?: boolean;
    requireInteraction?: boolean;
    onClick?: () => void;
  },
) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const chatId = options?.chatId;
  const tag = options?.tag || (chatId ? `pulse-${chatId}` : "pulse-chat");
  const silent = options?.silent !== false;
  const requireInteraction = Boolean(options?.requireInteraction);

  const wireClick = (note: Notification) => {
    note.onclick = () => {
      window.focus();
      options?.onClick?.();
      if (chatId) {
        window.dispatchEvent(
          new CustomEvent("pulse:open-chat", { detail: { chatId } }),
        );
      }
      note.close();
    };
  };

  void (async () => {
    try {
      const reg = await ensureNotifyServiceWorker();
      if (reg?.showNotification) {
        await reg.showNotification(title, {
          body,
          silent,
          tag,
          requireInteraction,
          data: chatId
            ? {
                chatId,
                kind: tag.startsWith("pulse-call") ? "call" : "chat",
              }
            : { kind: "chat" },
        });
        return;
      }
    } catch {
      /* fall back */
    }

    try {
      const note = new Notification(title, {
        body,
        silent,
        tag,
        requireInteraction,
      });
      wireClick(note);
    } catch {
      /* ignore */
    }
  })();
}

/** Close a notification by tag (SW or page-owned). */
export async function closeNotifyByTag(tag: string) {
  if (typeof window === "undefined") return;
  try {
    const reg = await ensureNotifyServiceWorker();
    const list = await reg?.getNotifications?.({ tag });
    list?.forEach((note) => note.close());
  } catch {
    /* ignore */
  }
}

export function showIncomingCallNotify(
  fromName: string,
  chatId: string,
  callId: string,
) {
  showDesktopNotify("Входящий звонок", `${fromName} звонит вам`, {
    chatId,
    tag: `pulse-call-${callId}`,
    silent: false,
    requireInteraction: true,
  });
}

export { formatLastSeenLabel as formatLastSeen } from "@/lib/dates";
