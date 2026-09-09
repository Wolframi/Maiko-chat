import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: process.env.PULSE_BASE_URL || "http://127.0.0.1:3000",
    headless: true,
    trace: "on-first-retry",
  },
  reporter: "list",
});
