/* Pulse — push + notification service worker */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {
    title: "Pulse",
    body: "Новое уведомление",
    chatId: "",
    callId: "",
    kind: "message",
    tag: "pulse-chat",
  };
  try {
    if (event.data) {
      data = { ...data, ...event.data.json() };
    }
  } catch {
    try {
      data.body = event.data ? event.data.text() : data.body;
    } catch {
      /* ignore */
    }
  }

  const tag =
    data.tag ||
    (data.callId
      ? `pulse-call-${data.callId}`
      : data.chatId
        ? `pulse-${data.chatId}`
        : "pulse-chat");

  const options = {
    body: String(data.body || ""),
    tag,
    renotify: true,
    requireInteraction: data.kind === "call",
    silent: false,
    data: {
      chatId: data.chatId || "",
      callId: data.callId || "",
      kind: data.kind || "message",
    },
    vibrate: data.kind === "call" ? [280, 120, 280, 120, 280] : [120, 60, 120],
  };

  event.waitUntil(
    self.registration.showNotification(String(data.title || "Pulse"), options),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification?.data || {};
  const tag = String(event.notification?.tag || "");
  let chatId = String(data.chatId || "");
  if (!chatId && tag.startsWith("pulse-") && !tag.startsWith("pulse-call-")) {
    chatId = tag.slice("pulse-".length);
  }

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if (chatId) {
            client.postMessage({ type: "pulse:open-chat", chatId });
          }
          if (data.callId) {
            client.postMessage({
              type: "pulse:incoming-call",
              callId: data.callId,
              chatId,
            });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        const url = chatId ? `/?chat=${encodeURIComponent(chatId)}` : "/";
        await self.clients.openWindow(url);
      }
    })(),
  );
});
