"use client";

import { preload } from "react-dom";
import { maikoIntroAsset, type MaikoIntro } from "@/lib/maikoIntro";

// This tiny component renders on the server too: download the selected dance
// from the first HTML, before the chat bundle and runtime finish initializing.
export function MaikoIntroPreload({ intro }: { intro: MaikoIntro }) {
  preload(maikoIntroAsset(intro), { as: "fetch", crossOrigin: "anonymous" });
  return null;
}
