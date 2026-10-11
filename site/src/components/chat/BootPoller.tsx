"use client";

import { useEffect } from "react";
import { watchAppBoot } from "@/lib/liveReload";

/** Starts deploy-reload polling even if the socket effect remounts. */
export function BootPoller() {
  useEffect(() => watchAppBoot(null), []);
  return null;
}
