import type { useBrowserCall } from "@/hooks/useCall";
import type { useBrowserVoiceChannel } from "@/hooks/useVoiceChannel";

export type DesktopMediaSession = { selfId: string; token: string; selfName?: string };
export type DesktopMediaSnapshot = {
  call: ReturnType<typeof useBrowserCall>;
  voice: ReturnType<typeof useBrowserVoiceChannel>;
};
export type DesktopMediaRuntime = {
  version: 1;
  getSnapshot: () => DesktopMediaSnapshot | null;
  subscribe: (listener: () => void) => () => void;
  configureSession: (session: DesktopMediaSession) => void;
  refresh: () => void;
  reportSiteUpdate: (phase: "loading" | "ready" | "error") => void;
};

declare global {
  interface Window {
    maikoMediaShell?: { version: 1; onRefresh: (listener: () => void) => () => void;
      siteUpdate: (phase: "loading" | "ready" | "error") => Promise<void> };
    maikoMediaRuntime?: DesktopMediaRuntime;
  }
}

/** Same-origin child only. The permanent owner never proxies its own hooks. */
export function getDesktopMediaRuntime(): DesktopMediaRuntime | null {
  if (typeof window === "undefined" || window.parent === window) return null;
  try {
    if (window.parent.location.origin !== window.location.origin) return null;
    const runtime = window.parent.maikoMediaRuntime;
    return runtime?.version === 1 ? runtime : null;
  } catch { return null; }
}

export function isDesktopMediaOwner() {
  return typeof window !== "undefined" && window.parent === window &&
    window.location.pathname === "/desktop-runtime" && window.maikoMediaShell?.version === 1;
}
