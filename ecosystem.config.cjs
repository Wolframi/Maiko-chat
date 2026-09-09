module.exports = {
  apps: [
    {
      name: "pulse-chat",
      cwd: "/root/pulse-chat",
      script: "npx",
      args: "tsx server.ts",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        HOSTNAME: "0.0.0.0",
        PORT: "3000",
        PUBLIC_ORIGIN: "https://193.233.247.171.sslip.io",
        TURN_HOST: "193.233.247.171",
        SEED_DEMO: "0",
        NEXT_PUBLIC_DEMO: "0",
        TRUST_PROXY: "1",
        UV_THREADPOOL_SIZE: "8",
      },
    },
  ],
};
