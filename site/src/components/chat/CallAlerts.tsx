"use client";

import { useEffect, useRef, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { IncomingCall } from "@/lib/types";
import { Avatar } from "./Avatar";
import { IconPhone, IconPhoneOff } from "@/lib/icons";
import { getSoundEnabled } from "@/lib/notify";
import { startIncomingRingtone, startOutgoingRingtone } from "@/lib/ringtone";
import { applyAudioOutput } from "@/lib/mediaDevices";
import { easeOutSoft, sheetSpring } from "@/lib/motion";

export function isOutboundRinging(outbound: boolean, status: string) {
  return outbound && (status === "Звоним…" || status === "Звонок" || status === "");
}

/** Signalling, ringtones and remote audio never wait for the optional video UI. */
export function CallAlerts({ incoming, active, status, incomingAvatarUrl = null, remoteAudioRef, onAccept, onReject }: {
  incoming: IncomingCall | null;
  active: { outbound: boolean } | null;
  status: string;
  incomingAvatarUrl?: string | null;
  remoteAudioRef: RefObject<HTMLAudioElement | null>;
  onAccept: () => void;
  onReject: () => void;
}) {
  const acceptRef = useRef<HTMLButtonElement>(null);
  const showIncoming = Boolean(incoming && !active);
  const outgoing = Boolean(active && isOutboundRinging(active.outbound, status));
  useEffect(() => {
    if (showIncoming && getSoundEnabled()) return startIncomingRingtone();
  }, [showIncoming]);
  useEffect(() => {
    if (outgoing && getSoundEnabled()) return startOutgoingRingtone();
  }, [outgoing]);
  useEffect(() => {
    if (!showIncoming) return;
    const timer = window.setTimeout(() => acceptRef.current?.focus(), 40);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onReject(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, [showIncoming, onReject]);
  useEffect(() => { void applyAudioOutput(remoteAudioRef.current); }, [remoteAudioRef, active]);
  return <>
    <audio ref={remoteAudioRef} autoPlay playsInline hidden />
    <AnimatePresence>
      {showIncoming && incoming && <motion.div className="call" role="dialog" aria-modal="true" aria-label="Входящий звонок"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: easeOutSoft }}>
        <motion.div className="call__card call__card--incoming" initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }} transition={sheetSpring}>
          <div className="call__ring"><Avatar name={incoming.fromName} src={incomingAvatarUrl} size="lg" /></div>
          <p className="call__label">Входящий звонок</p>
          <h2 className="call__name">{incoming.fromName}</h2>
          <div className="call__actions call__actions--dock">
            <button type="button" className="call__btn call__btn--circle call__btn--bad" onClick={onReject} aria-label="Отклонить" title="Отклонить"><IconPhoneOff size={22} /></button>
            <button ref={acceptRef} type="button" className="call__btn call__btn--circle call__btn--ok" onClick={onAccept} aria-label="Ответить" title="Ответить"><IconPhone size={22} /></button>
          </div>
        </motion.div>
      </motion.div>}
    </AnimatePresence>
  </>;
}
