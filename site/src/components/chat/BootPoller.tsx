"use client";

import { useEffect } from "react";
import { watchAppBoot } from "@/lib/liveReload";
import { SiteUpdateNotice } from "@/components/chat/SiteUpdateNotice";

/** Starts deploy-reload polling even if the socket effect remounts. */
export function BootPoller() {
  useEffect(() => watchAppBoot(null), []);
  return <SiteUpdateNotice />;
}
