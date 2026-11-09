"use client";

import { useEffect, useState } from "react";
import { subscribeMediaDownload, type MediaDownload } from "@/lib/mediaDownload";

export function useMediaDownload(source: string, enabled: boolean) {
  const [state, setState] = useState<MediaDownload & { request: string }>({ request: "", received: 0 });
  useEffect(() => {
    if (!enabled || !source) return;
    return subscribeMediaDownload(source, next => setState({ ...next, request: source }));
  }, [enabled, source]);
  return enabled && state.request === source ? state : { received: 0 } as MediaDownload;
}
