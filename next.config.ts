import type { NextConfig } from "next";
import { lanDevHosts } from "./src/lib/devHosts";

const nextConfig: NextConfig = {
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
    "@livekit/krisp-noise-filter",
    "@shiguredo/rnnoise-wasm",
  ],
};

export default nextConfig;
