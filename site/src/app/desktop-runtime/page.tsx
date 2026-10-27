import type { Metadata } from "next";
import { DesktopMediaHost } from "@/components/chat/DesktopMediaHost";

export const metadata: Metadata = { other: { "maiko-desktop-startup": "local-model" } };

export default function DesktopRuntimePage() {
  return <DesktopMediaHost />;
}
