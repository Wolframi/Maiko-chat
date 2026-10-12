import type { Server } from "socket.io";
import { readFileSync, watchFile, unwatchFile } from "node:fs";
import path from "node:path";

type Notice = { version: string };
export function configureDesktopUpdateNotifications(io: Server, filename = path.join(process.cwd(), "data/desktop-release.json")) {
  const namespace = io.of("/desktop-updates");
  let current: Notice | undefined;
  function readNotice() {
    try {
      const notice = JSON.parse(readFileSync(filename, "utf8"));
      if (typeof notice.version === "string" && /^\d+\.\d+\.\d+$/.test(notice.version)) return { version: notice.version };
    } catch { /* The first release may not have been published yet. */ }
  }
  current = readNotice();
  const connect = (socket: { emit: (event: string, notice: Notice) => unknown }) => {
    if (current) socket.emit("desktop:update-available", current);
  };
  namespace.on("connection", connect);
  io.on("connection", connect);
  const refresh = () => {
    const next = readNotice();
    if (!next || next.version === current?.version) return;
    current = next;
    namespace.emit("desktop:update-available", next);
    io.emit("desktop:update-available", next);
  };
  // Publication atomically renames this tiny notice only after both feeds are
  // ready. Watch the filename so replacement also wakes connected clients.
  watchFile(filename, { interval: 1000, persistent: false }, refresh);
  return () => {
    unwatchFile(filename, refresh);
    namespace.off("connection", connect);
    io.off("connection", connect);
  };
}
