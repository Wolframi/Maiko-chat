"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

type Invite = { ok: true; code: string; expiresAt: number; serverTime: number; required: boolean; canManage: boolean };
type Failure = { ok: false; error?: string };

export function RegistrationInvitesPanel({ socket, connected }: { socket: Socket | null; connected: boolean }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const deadline = useRef(0);
  const active = useRef(false);
  const working = useRef(false);

  const request = useCallback(async () => {
    if (!socket?.connected) throw new Error("Нет соединения с сервером");
    const started = performance.now();
    const result = await socket.timeout(10000).emitWithAck("registration:invite", {}) as Invite | Failure;
    if (!result.ok) throw new Error(result.error || "Не удалось получить приглашение");
    if (!active.current) throw new Error("Профиль закрыт");
    // Account for time spent in transit; never copy a code past its deadline.
    deadline.current = performance.now() + result.expiresAt - result.serverTime - (performance.now() - started);
    setInvite(result);
    setRemaining(Math.max(0, deadline.current - performance.now()));
    setCopied(false);
    setError("");
    return result;
  }, [socket]);

  useEffect(() => {
    active.current = true;
    const refresh = () => { void request().catch(e => { if (active.current) setError(e instanceof Error ? e.message : "Не удалось загрузить код"); }); };
    if (connected) refresh();
    const policy = (value: { required: boolean }) => {
      setInvite(previous => previous ? { ...previous, required: value.required } : previous);
    };
    socket?.on("registration:policy", policy);
    const retry = window.setInterval(() => { if (socket?.connected) refresh(); }, 60000);
    return () => { active.current = false; window.clearInterval(retry); socket?.off("registration:policy", policy); };
  }, [connected, request, socket]);

  useEffect(() => {
    if (!invite || !connected) return;
    const tick = window.setInterval(() => setRemaining(Math.max(0, deadline.current - performance.now())), 1000);
    const rotate = window.setTimeout(() => {
      setRemaining(0);
      setCopied(false);
      void request().catch(() => { if (active.current) setError("Не удалось обновить код. Повторите попытку"); });
    }, Math.max(100, deadline.current - performance.now() + 100));
    return () => { window.clearInterval(tick); window.clearTimeout(rotate); };
  }, [invite?.code, connected, request]);

  async function copy() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const current = await request();
      if (deadline.current <= performance.now()) throw new Error("Код обновился. Нажмите ещё раз");
      await navigator.clipboard.writeText(current.code);
      if (active.current) setCopied(true);
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : "Не удалось скопировать код. Выделите его вручную"); }
    finally { working.current = false; if (active.current) setBusy(false); }
  }

  async function configure() {
    if (!invite || !socket?.connected || working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await socket.timeout(10000).emitWithAck("registration:configure", { required: !invite.required }) as { ok: boolean; required: boolean; error?: string };
      if (!result.ok) throw new Error(result.error || "Не удалось сохранить настройку");
      if (active.current) setInvite(previous => previous ? { ...previous, required: result.required } : previous);
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : "Нет ответа сервера"); }
    finally { working.current = false; if (active.current) setBusy(false); }
  }

  const minutes = Math.ceil(remaining / 60000);
  return <section className="registration-invites" aria-label="Приглашения в Майко">
    <p>Пригласите знакомого в Майко: отправьте ему свой код для регистрации.</p>
    <label className="field">
      <span>Ваш код приглашения</span>
      <input readOnly value={connected && remaining > 0 ? invite?.code || "" : ""} placeholder={connected ? "Загрузка…" : "Нет соединения"} aria-label="Ваш код приглашения" />
    </label>
    <p className="registration-invites__hint">Код обновляется раз в неделю. {connected && invite && remaining > 0 ? `До обновления: ${Math.floor(minutes / 1440)} д ${Math.floor(minutes / 60) % 24} ч ${minutes % 60} мин.` : ""}</p>
    <button type="button" className="primary-btn" disabled={!connected || busy} onClick={() => void copy()}>
      {busy ? "Подождите…" : "Скопировать приглашение в Майко"}
    </button>
    {copied && <p role="status">Код скопирован</p>}
    {invite?.canManage && <div className="registration-invites__admin">
      <strong>Регистрация на сайте</strong>
      <p className="registration-invites__hint">{invite.required ? "Новые аккаунты создаются только по приглашению." : "Регистрация открыта для всех. Код не требуется."}</p>
      <button type="button" role="switch" aria-checked={invite.required} aria-label="Регистрация по приглашениям"
        className="secondary-btn" disabled={!connected || busy} onClick={() => void configure()}>
        {invite.required ? "Отключить код приглашения" : "Включить код приглашения"}
      </button>
    </div>}
    {error && <p className="registration-invites__error" role="alert">{error}</p>}
  </section>;
}
