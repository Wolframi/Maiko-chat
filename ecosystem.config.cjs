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
      cwd: "/root/pulse-chat",
      script: "npm",
      args: "start",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "700M",
      // Crash-loop guard: stop restarting after a burst instead of 297 loops.
      min_uptime: "3s",
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: "3000",
        PUBLIC_ORIGIN: "https://193.233.247.171.sslip.io",
        // Domain (not IP) so clients also get turns:…5349 relay.
        TURN_HOST: "193.233.247.171.sslip.io",
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
