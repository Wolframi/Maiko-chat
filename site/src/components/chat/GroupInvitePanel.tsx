"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import type { GroupInviteCodeResult } from "@/lib/types";
import { IconUserPlus } from "@/lib/icons";

export function GroupInviteButton({ groupId, onGetCode }: {
  groupId: string;
  onGetCode: (groupId: string) => Promise<GroupInviteCodeResult>;
}) {
  const [copying, setCopying] = useState(false);
  const busy = useRef(false);

  async function copy() {
    if (busy.current) return;
    busy.current = true;
    setCopying(true);
    const started = performance.now();
    try {
      const result = await onGetCode(groupId);
      if (!result.ok || !result.invite) {
        toast.error(result.error || "Не удалось получить код приглашения");
        return;
      }
      if (result.invite.expiresAt - result.invite.serverTime <= performance.now() - started) {
        toast.error("Код обновился. Нажмите ещё раз");
        return;
      }
      await navigator.clipboard.writeText(result.invite.code);
      toast.success("Код приглашения скопирован");
    } catch {
      toast.error("Не удалось скопировать код. Попробуйте ещё раз");
    } finally {
      busy.current = false;
      setCopying(false);
    }
  }

  return (
    <button className="icon-btn room__invite-btn" type="button"
      aria-label="Скопировать код приглашения" title="Скопировать код приглашения"
      disabled={copying} aria-busy={copying} onClick={() => void copy()}>
      <IconUserPlus size={18} />
    </button>
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
