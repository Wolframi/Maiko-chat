"use client";

import { preload } from "react-dom";
import { maikoIntroAsset, type MaikoIntro } from "@/lib/maikoIntro";
import { maikoParticleGraphAsset } from "@/lib/maikoParticleGraph";

// This tiny component renders on the server too: download the selected dance
// from the first HTML, before the chat bundle and runtime finish initializing.
export function MaikoIntroPreload({ intro }: { intro: MaikoIntro }) {
  preload(maikoIntroAsset(intro), { as: "fetch", crossOrigin: "anonymous" });
  for (const count of [40000, 84000]) {
    const asset = maikoParticleGraphAsset(intro, count);
    if (asset) preload(asset, { as: "fetch", crossOrigin: "anonymous", media: count === 40000 ? "(width < 600px)" : "(width >= 600px)" });
  }
  return null;
}
