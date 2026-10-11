const fs = require("fs");
const path = require("path");

function readSecret(filename) {
  try {
    return fs
      .readFileSync(path.join(__dirname, filename), "utf8")
      .replace(/\r/g, "")
      .trim();
  } catch {
    return "";
  }
}

const giphyKey = readSecret(".giphy-api-key");
const deepgramKey = readSecret(".deepgram-api-key");

module.exports = {
  apps: [
    {
      name: "pulse-chat",
      cwd: path.join(__dirname, "site"),
      script: "server.ts",
      interpreter: process.execPath,
      node_args: "--import tsx",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "700M",
      // Crash-loop guard: stop restarting after a burst instead of 297 loops.
      min_uptime: "3s",
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 20000,
      env: {
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: "3000",
        PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || "https://maiko.galacticvps.qzz.io",
        // Domain (not IP) so clients also get turns:…5349 relay.
        TURN_HOST: process.env.TURN_HOST || "maiko.galacticvps.qzz.io",
        SEED_DEMO: "0",
        NEXT_PUBLIC_DEMO: "0",
        TRUST_PROXY: "1",
        UV_THREADPOOL_SIZE: "8",
        ...(giphyKey ? { GIPHY_API_KEY: giphyKey } : {}),
        ...(deepgramKey ? { DEEPGRAM_API_KEY: deepgramKey } : {}),
      },
    },
  ],
};
