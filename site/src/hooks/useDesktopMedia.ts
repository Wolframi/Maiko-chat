"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getDesktopMediaRuntime, type DesktopMediaSession } from "@/lib/desktopMedia";

const getSnapshot = () => getDesktopMediaRuntime()?.getSnapshot() ?? null;
const serverSnapshot = () => null;
function subscribe(listener: () => void) {
  const stop = getDesktopMediaRuntime()?.subscribe(listener) ?? (() => {});
  // Navigation does not unmount a React tree. Remove the old frame's closures
  // from the permanent owner's subscriptions before destroying the document.
  window.addEventListener("pagehide", stop, { once: true });
  return () => { stop(); window.removeEventListener("pagehide", stop); };
}

export function useDesktopMedia(session: Partial<DesktopMediaSession>) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  useEffect(() => {
    if (!session.token || !session.selfId) return;
    getDesktopMediaRuntime()?.configureSession({ token: session.token, selfId: session.selfId, selfName: session.selfName });
  }, [session.token, session.selfId, session.selfName]);
  return snapshot;
}
