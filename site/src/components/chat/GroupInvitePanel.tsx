"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { GroupInviteCodeResult } from "@/lib/types";
import { IconUserPlus } from "@/lib/icons";

/** Clipboard API is unavailable on plain HTTP / without permission in some browsers. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function GroupInviteButton({ groupId, onGetCode }: {
  groupId: string;
  onGetCode: (groupId: string) => Promise<GroupInviteCodeResult>;
}) {
  const [copying, setCopying] = useState(false);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const busy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  async function loadCode() {
    if (busy.current) return null;
    busy.current = true;
    setCopying(true);
    const started = performance.now();
    try {
      const result = await onGetCode(groupId);
      if (!result.ok || !result.invite) {
        toast.error(result.error || "Не удалось получить код приглашения");
        return null;
      }
      if (result.invite.expiresAt - result.invite.serverTime <= performance.now() - started) {
        toast.error("Код обновился. Нажмите ещё раз");
        return null;
      }
      return result.invite.code;
    } catch {
      toast.error("Не удалось получить код. Попробуйте ещё раз");
      return null;
    } finally {
      busy.current = false;
      setCopying(false);
    }
  }

  async function openPanel() {
    const next = await loadCode();
    if (!next) return;
    setCode(next);
    setOpen(true);
    const copied = await copyText(next);
    if (copied) toast.success("Код приглашения скопирован");
    else toast("Код открыт — выделите его и скопируйте вручную");
  }

  async function copyAgain() {
    const copied = await copyText(code);
    if (copied) toast.success("Код приглашения скопирован");
    else toast.error("Браузер не разрешил копирование — выделите код в поле вручную");
  }

  return (
    <div className="group-invite-wrap">
      <button className="icon-btn room__invite-btn" type="button"
        aria-label="Показать код приглашения" title="Показать код приглашения"
        disabled={copying} aria-busy={copying} aria-expanded={open}
        onClick={() => void openPanel()}>
        <IconUserPlus size={18} />
      </button>
      {open && (
        <div className="group-invite-pop" role="dialog" aria-label="Код приглашения">
          <div className="group-invite-pop__head">
            <span className="group-invite-pop__title">Код приглашения</span>
            <button type="button" className="group-invite-pop__close" aria-label="Закрыть"
              onClick={() => setOpen(false)}>×</button>
          </div>
          <input
            ref={inputRef}
            className="group-invite-pop__code"
            aria-label="Код приглашения"
            value={code}
            readOnly
            spellCheck={false}
            autoComplete="off"
            onFocus={event => event.currentTarget.select()}
            onClick={event => event.currentTarget.select()}
          />
          <p className="group-invite-pop__hint">
            Отправьте код боту в личные сообщения — он сам вступит в группу.
          </p>
          <div className="group-invite-pop__actions">
            <button type="button" className="group-invite-pop__copy" onClick={() => void copyAgain()}>
              Скопировать
            </button>
            <button type="button" className="group-invite-pop__cancel" onClick={() => setOpen(false)}>
              Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function GroupCodeJoinForm({ onJoin }: {
  onJoin: (code: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form className="group-invite" aria-label="Вступить по коду" onSubmit={async event => {
      event.preventDefault();
      if (joining || !code.trim()) return;
      setJoining(true);
      setError(null);
      try {
        const result = await onJoin(code.trim());
        if (!result.ok) setError(result.error || "Не удалось вступить в группу");
        else setCode("");
      } catch { setError("Нет соединения с сервером"); }
      finally { setJoining(false); }
    }}>
      <label className="field">
        <span>Вступить по коду</span>
        <input className="group-invite__code" aria-label="Код для вступления" placeholder="XXXX-XXXX-XXXX" value={code} onChange={event => { setCode(event.target.value.toUpperCase()); setError(null); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={32} disabled={joining} />
      </label>
      <button className="group-invite__button" type="submit" disabled={joining || !code.trim()}>{joining ? "Подключение…" : "Вступить"}</button>
      {error && <p className="group-invite__error" role="alert">{error}</p>}
    </form>
  );
}
