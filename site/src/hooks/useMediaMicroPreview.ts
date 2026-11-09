"use client";

import { useEffect, useState } from "react";
import { validMicroPreview } from "@/lib/microPreview";
import { loadMediaMicroPreview } from "@/lib/mediaMicroPreview";

export function useMediaMicroPreview(source: string, value: string | undefined, enabled: boolean) {
  const supplied = validMicroPreview(value);
  const [resolved, setResolved] = useState<{ source: string; value: string }>();
  useEffect(() => {
    if (supplied || !enabled) return;
    let current = true;
    void loadMediaMicroPreview(source).then(preview => { if (current && preview) setResolved({ source, value: preview }); });
    return () => { current = false; };
  }, [enabled, source, supplied]);
  return supplied || (resolved?.source === source ? resolved.value : undefined);
}
