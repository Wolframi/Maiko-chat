import type { NextConfig } from "next";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { lanDevHosts } from "./src/lib/devHosts";
import { MAIKO_MODEL_VERSION } from "./src/lib/maikoIntro";

const nextConfig: NextConfig = {
  generateBuildId: async () => process.env.NEXT_PUBLIC_SITE_VERSION || randomUUID(),
  env: { NEXT_PUBLIC_SITE_VERSION: process.env.NEXT_PUBLIC_SITE_VERSION || "" },
  productionBrowserSourceMaps: false,
  // The Electron client has its own lockfile; keep the web workspace explicit.
  turbopack: { root: process.cwd() },
  async headers() {
    return [...["runtime.wasm", "model-1.tflite", "model-2.tflite"].map((asset) => ({
      source: `/audio/dtln-0.1.1/${asset}`,
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    })), ...["hiphop", "samba"].map(intro => ({
      source: `/models/maiko-${intro}.bin.gz`,
      headers: [
        { key: "Content-Encoding", value: "gzip" },
        { key: "Content-Type", value: "application/octet-stream" },
      ],
    })), ...["hiphop", "samba"].map(intro => ({
      source: `/models/maiko-${intro}.bin.gz`,
      has: [{ type: "query" as const, key: "v", value: MAIKO_MODEL_VERSION }],
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    }))];
  },
  // Dev HMR/assets when opening via LAN IP, 127.0.0.1, or Cloudflare tunnels
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "*.local",
    "*.trycloudflare.com",
    ...lanDevHosts(),
  ],
  transpilePackages: [
    "react-voice-recorder-kit",
    "@wavesurfer/react",
    "wavesurfer.js",
    "emoji-mart",
    "@emoji-mart/react",
    "@emoji-mart/data",
    "emojibase-data",
    "yet-another-react-lightbox",
    "sonner",
    "linkify-react",
    "linkifyjs",
    "lucide-react",
    "react-textarea-autosize",
    "vaul",
  ],
};

nextConfig.webpack = (config, { dev, isServer }) => {
  if (!dev && !isServer) {
    // Build-only dependency: production servers and isolated fixtures do not
    // need to install or import the obfuscator when loading this config.
    const { CodeProtectionPlugin } = createRequire(path.join(process.cwd(), "package.json"))("./scripts/code-protection.cjs");
    config.devtool = false;
    config.plugins.push(new CodeProtectionPlugin(process.cwd()));
  }
  if (dev) {
    const extra = ["**/uploads/**", "**/data/**"];
    const prev = config.watchOptions?.ignored;
    const ignored =
      typeof prev === "function"
        ? (file: string) =>
            prev(file) || /(?:^|[/\\])(?:uploads|data)(?:[/\\]|$)/.test(file)
        : [
            ...(Array.isArray(prev)
              ? prev
              : prev
                ? [prev]
                : ["**/node_modules/**"]),
            ...extra,
          ];
    config.watchOptions = {
      ...config.watchOptions,
      ignored,
    };
  }
  return config;
};

export default nextConfig;
