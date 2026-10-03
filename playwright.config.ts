import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

process.env.JSONBIN_TEST_PASSWORD ??= randomBytes(32).toString("hex");
process.env.JSONBIN_TEST_SESSION_SECRET ??= randomBytes(32).toString("hex");
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
    launchOptions: existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] } : {},
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/start-dev.mjs",
    url: "http://127.0.0.1:5174/api/v1/system/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
