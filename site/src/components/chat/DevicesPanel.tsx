"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Laptop, MapPin, Smartphone, Tablet } from "lucide-react";
import { toast } from "sonner";
import type { Socket } from "socket.io-client";
import type { DeviceSession, DeviceSessionsResult } from "@/lib/deviceSessions";
import { ConfirmDialog } from "./ConfirmDialog";

function date(value: number) {
  return new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function DevicesPanel({ socket, connected, onLogout }: {
  socket: Socket | null; connected: boolean; onLogout: () => void;
}) {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<DeviceSession | "others" | null>(null);
  const generation = useRef(0);
  const working = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!socket?.connected || working.current) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await socket.timeout(10000).emitWithAck("auth:devices", {}) as DeviceSessionsResult;
      if (request !== generation.current) return;
      if (!result.ok) throw new Error(result.error);
      setSessions(result.sessions);
      setError("");
    } catch (e) {
      if (request === generation.current) setError(e instanceof Error ? e.message : "Не удалось загрузить устройства");
    } finally { if (request === generation.current) setLoading(false); }
  }, [socket]);

  useEffect(() => {
    const requests = generation;
    if (connected) void refresh();
    const changed = () => { void refresh(); };
    socket?.on("auth:devices-changed", changed);
    const timer = window.setInterval(changed, 30000);
    return () => { ++requests.current; window.clearInterval(timer); socket?.off("auth:devices-changed", changed); };
  }, [connected, socket, refresh]);

  async function revoke() {
    if (!selected || !socket?.connected || working.current) return;
    if (selected !== "others" && selected.current) { onLogout(); return; }
    working.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await socket.timeout(10000).emitWithAck("auth:device-revoke",
        selected === "others" ? { others: true } : { id: selected.id }) as DeviceSessionsResult;
      if (request !== generation.current) return;
      if (!result.ok) throw new Error(result.error);
      setSessions(result.sessions);
      toast.success(selected === "others" ? "Все остальные сеансы завершены" : "Сеанс на устройстве завершён", { duration: 3000 });
      setSelected(null);
    } catch (e) {
      if (request === generation.current) { setError(e instanceof Error ? e.message : "Не удалось завершить сеанс"); setSelected(null); }
    } finally {
      working.current = false;
      if (mounted.current) { setBusy(false); setLoading(false); }
    }
  }

  return <section className="devices" aria-label="Устройства и сеансы" aria-busy={loading || busy}>
    <p className="devices__hint">Здесь показаны активные входы в ваш аккаунт. Место входа определяется приблизительно по IP: при VPN может отображаться другой город.</p>
    <div className="devices__toolbar">
      <button type="button" disabled={!connected || loading || busy} onClick={() => void refresh()}>Обновить</button>
      <button type="button" className="devices__danger" disabled={!connected || busy || !sessions?.some(session => !session.current)} onClick={() => setSelected("others")}>
        Завершить другие сеансы
      </button>
    </div>
    {!connected && <p role="status">Нет соединения с сервером</p>}
    {loading && !sessions && connected && <p role="status">Загрузка устройств…</p>}
    {error && <p className="devices__error" role="alert">{error}</p>}
    <ul className="devices__list">
      {sessions?.map(session => {
        const Icon = session.device === "mobile" ? Smartphone : session.device === "tablet" ? Tablet : Laptop;
        return <li key={session.id} className={`devices__item${session.current ? " is-current" : ""}`}>
          <Icon size={24} aria-hidden="true" className="devices__icon" />
          <div className="devices__details">
            <strong>{session.browser} · {session.os}</strong>
            {session.current && <span className="devices__current">Это устройство</span>}
            <p className="devices__location"><MapPin size={13} aria-hidden="true" />{session.location || "Место входа неизвестно"}</p>
            <p>IP: <span className="devices__ip">{session.ip || "Не сохранён"}</span></p>
            <p>Вход: <time dateTime={new Date(session.issuedAt).toISOString()}>{date(session.issuedAt)}</time></p>
            <p>Активность: <time dateTime={new Date(session.lastSeenAt).toISOString()}>{date(session.lastSeenAt)}</time></p>
            <button type="button" className="devices__danger" disabled={!connected || busy}
              aria-label={session.current ? "Выйти на этом устройстве" : `Завершить сеанс: ${session.browser} · ${session.os}`}
              onClick={() => setSelected(session)}>{session.current ? "Выйти" : "Завершить сеанс"}</button>
          </div>
        </li>;
      })}
    </ul>
    <ConfirmDialog open={selected !== null} busy={busy} title={selected === "others" ? "Завершить другие сеансы?" : "Выйти на устройстве?"}
      body={selected === "others" ? "На всех остальных устройствах потребуется снова войти. Этот сеанс останется активным."
        : selected ? `${selected.browser} · ${selected.os}. Для продолжения работы на этом устройстве потребуется снова войти.` : ""}
      confirmLabel={selected === "others" ? "Завершить все остальные" : "Выйти"}
      onCancel={() => setSelected(null)} onConfirm={() => void revoke()} />
  </section>;
}
