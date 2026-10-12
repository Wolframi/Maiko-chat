"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useBrowserCall } from "@/hooks/useCall";
import { useBrowserVoiceChannel } from "@/hooks/useVoiceChannel";
import { isDesktopMediaOwner, type DesktopMediaRuntime, type DesktopMediaSession, type DesktopMediaSnapshot } from "@/lib/desktopMedia";
import { configureCallAudioCapture } from "@/lib/webrtcMedia";

export function DesktopMediaHost() {
  const [enabled, setEnabled] = useState(false);
  const [session, setSession] = useState<DesktopMediaSession | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [revision, setRevision] = useState(0);
  const listeners = useRef(new Set<() => void>());
  const snapshot = useRef<DesktopMediaSnapshot | null>(null);
  const reportSiteUpdate = useCallback((phase: "loading" | "ready" | "error") => {
    void window.maikoMediaShell?.siteUpdate(phase).catch(() => {});
  }, []);
  const refresh = useCallback(() => {
    reportSiteUpdate("loading");
    setRevision(value => value + 1);
  }, [reportSiteUpdate]);
  const [runtime] = useState<DesktopMediaRuntime>(() => ({
    version: 1, getSnapshot: () => snapshot.current,
    subscribe(listener) { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
    configureSession(next) { setSession(previous => previous?.token === next.token && previous.selfId === next.selfId && previous.selfName === next.selfName ? previous : next); },
    refresh,
    reportSiteUpdate,
  }));
  const transport = useRef<Socket | null>(null);
  const call = useBrowserCall({ socket, selfId: session?.selfId, token: session?.token,
    onLog: useCallback((chatId: string, text: string) => transport.current?.emit("call:log", { chatId, text }), []),
  });
  const voice = useBrowserVoiceChannel({ socket, selfId: session?.selfId, selfName: session?.selfName,
    token: session?.token, callBusy: Boolean(call.active || call.incoming) });

  useEffect(() => {
    if (!isDesktopMediaOwner()) return;
    setEnabled(true);
    window.maikoMediaRuntime = runtime;
    const stopRefresh = window.maikoMediaShell!.onRefresh(refresh);
    return () => { stopRefresh(); delete window.maikoMediaRuntime; };
  }, [runtime, refresh]);

  useEffect(() => {
    snapshot.current = { call, voice };
    for (const listener of listeners.current) listener();
  }, [call, voice]);

  useEffect(() => {
    if (!enabled) return;
    const client = io({ path: "/api/socket", autoConnect: false, transports: ["polling", "websocket"],
      rememberUpgrade: true, reconnectionDelay: 700, reconnectionDelayMax: 8000 });
    transport.current = client;
    const restore = () => {
      const token = localStorage.getItem("pulse-chat-token");
      if (!token) return;
      client.emit("auth:restore", { token }, (result: { ok?: boolean; account?: { userId: string; displayName?: string; username: string } }) => {
        if (localStorage.getItem("pulse-chat-token") !== token) return;
        if (!result.ok || !result.account) { setSession(null); setSocket(null); return; }
        setSession(previous => previous?.token === token ? previous : { token, selfId: result.account!.userId,
          selfName: result.account!.displayName || result.account!.username });
        setSocket(client);
      });
    };
    client.on("connect", restore);
    client.on("disconnect", reason => { if (reason === "io server disconnect") client.connect(); });
    const changed = (event: StorageEvent) => {
      if (event.key !== "pulse-chat-token") return;
      if (!event.newValue) { setSession(null); setSocket(null); }
      else restore();
    };
    window.addEventListener("storage", changed);
    client.connect();
    return () => { window.removeEventListener("storage", changed); client.disconnect(); transport.current = null; };
  }, [enabled]);

  useEffect(() => {
    const client = transport.current;
    if (!session?.token || !client?.connected) return;
    client.emit("auth:restore", { token: session.token }, (result: { ok?: boolean }) => {
      if (localStorage.getItem("pulse-chat-token") !== session.token) return;
      if (result.ok) setSocket(client);
    });
  }, [session?.token]);

  useEffect(() => {
    configureCallAudioCapture(Boolean(call.active || voice.active));
    return () => configureCallAudioCapture(false);
  }, [call.active, voice.active]);

  if (!enabled) return <p>Эта страница используется приложением Майко.</p>;
  return <>
    <audio ref={call.remoteAudioRef} autoPlay playsInline hidden />
    <iframe key={revision} data-maiko-desktop-ui title="Майко" src="/?_desktop_ui=1"
      allow="camera; microphone; display-capture; autoplay; clipboard-read; clipboard-write"
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: 0 }} />
  </>;
}
