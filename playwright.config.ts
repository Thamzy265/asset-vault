import { defineConfig, devices } from "@playwright/test";

// Runs against the Compose stack, which must already be up: `docker compose up -d --wait`.
const port = process.env.WEB_PORT ?? "3000";

export default defineConfig({
  testDir: "e2e",
  outputDir: "qa-artifacts/playwright",
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
