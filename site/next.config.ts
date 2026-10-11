import type { NextConfig } from "next";
import { lanDevHosts } from "./src/lib/devHosts";

const nextConfig: NextConfig = {
  // The Electron client has its own lockfile; keep the web workspace explicit.
  turbopack: { root: process.cwd() },
  async headers() {
    return ["runtime.wasm", "model-1.tflite", "model-2.tflite"].map((asset) => ({
      source: `/audio/dtln-0.1.1/${asset}`,
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    }));
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

if (process.env.NODE_ENV !== "production") {
  nextConfig.webpack = (config, { dev }) => {
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
}

export default nextConfig;
